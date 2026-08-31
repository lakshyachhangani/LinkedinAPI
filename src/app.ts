import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { AppError, isAppError } from "./domain/errors.js";
import { LinkedInScraper } from "./extractor/linkedin-scraper.js";
import { calculateCompleteness } from "./extractor/mapper.js";
import type { ProfileScraper } from "./extractor/types.js";
import { normalizeLinkedInProfileUrl } from "./lib/linkedin-url.js";
import { Metrics } from "./observability/metrics.js";
import { ProfileService } from "./service/profile-service.js";
import { buildApiKeyGuard, fingerprintApiKey } from "./api/auth.js";
import { errorResponseSchema, profileRequestSchema, profileResponseSchema } from "./api/schemas.js";

interface ProfileBody {
  profileUrl: string;
  refresh?: boolean;
}

export interface AppOptions {
  config: Config;
  scraper?: ProfileScraper;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    trustProxy:
      config.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < config.trustProxyHops
        : false,
    bodyLimit: 16 * 1024,
    requestTimeout: config.scrapeTimeoutMs + 15_000,
    logger: {
      level: config.logLevel,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-api-key", "res.headers.set-cookie"],
        censor: "[REDACTED]"
      },
      ...(config.nodeEnv === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true, singleLine: true } } }
        : {})
    },
    genReqId: (request) => {
      const provided = request.headers["x-request-id"];
      return typeof provided === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(provided) ? provided : crypto.randomUUID();
    }
  });
  const scraper = options.scraper ?? new LinkedInScraper(config);
  const service = new ProfileService(scraper, config);
  const metrics = new Metrics();
  const apiKeyGuard = buildApiKeyGuard(config.apiKeys);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    global: false,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    keyGenerator: (request) => {
      const apiKey = request.headers["x-api-key"];
      return typeof apiKey === "string" ? `key:${fingerprintApiKey(apiKey)}` : `ip:${request.ip}`;
    },
    errorResponseBuilder: (request, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: `Rate limit exceeded; retry in ${context.after}`,
        retryable: true,
        requestId: request.id
      }
    })
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "LinkedIn Profile API",
        version: "1.0.0",
        description: "Extract structured profile data through reverse-engineered LinkedIn Voyager HTTP endpoints."
      },
      components: {
        securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } }
      }
    }
  });
  await app.register(swaggerUi, { routePrefix: "/documentation" });

  app.get("/health/live", { schema: { hide: true } }, () => ({ status: "ok" }));
  app.get("/health/ready", { schema: { hide: true } }, async (request, reply) => {
    try {
      await scraper.checkReady();
      metrics.serviceUp.set(1);
      return { status: "ok" };
    } catch (error) {
      metrics.serviceUp.set(0);
      request.log.warn({ errorType: error instanceof Error ? error.name : "UnknownError" }, "Readiness check failed");
      return reply.status(503).send({ status: "unavailable" });
    }
  });
  app.get("/metrics", { preHandler: apiKeyGuard, schema: { hide: true } }, async (_request, reply) => {
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  app.post<{ Body: ProfileBody }>(
    "/v1/profiles",
    {
      preHandler: apiKeyGuard,
      config: { rateLimit: { max: config.rateLimitMax, timeWindow: config.rateLimitWindow } },
      schema: {
        operationId: "extractLinkedInProfile",
        summary: "Extract a LinkedIn profile",
        tags: ["profiles"],
        security: config.apiKeys.length > 0 ? [{ apiKey: [] }] : [],
        body: profileRequestSchema,
        response: {
          200: profileResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
          504: errorResponseSchema,
          500: errorResponseSchema
        }
      }
    },
    async (request, reply) => {
      const startedAt = process.hrtime.bigint();
      try {
        reply.header("Cache-Control", "no-store");
        const profileUrl = normalizeLinkedInProfileUrl(request.body.profileUrl);
        const result = await service.getProfile(profileUrl, request.body.refresh ?? false);
        metrics.cacheTotal.inc({ result: result.cache });
        metrics.scrapeTotal.inc({ outcome: "success" });
        metrics.scrapeDuration.observe(
          { outcome: "success" },
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
        );
        return {
          data: result.output.profile,
          meta: {
            requestId: request.id,
            fetchedAt: result.fetchedAt,
            cache: result.cache,
            extractionMode: result.output.extractionMode,
            completeness: calculateCompleteness(result.output.profile),
            warnings: result.output.warnings
          }
        };
      } catch (error) {
        metrics.scrapeTotal.inc({ outcome: isAppError(error) ? error.code : "internal_error" });
        metrics.scrapeDuration.observe(
          { outcome: "error" },
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
        );
        throw error;
      }
    }
  );

  app.setNotFoundHandler(async (request, reply) => {
    return reply.status(404).send({
      error: { code: "INVALID_REQUEST", message: "Route not found", retryable: false, requestId: request.id }
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    const normalized = normalizeError(error);
    if (normalized.statusCode >= 500) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      const fields = config.nodeEnv === "production" ? { code: normalized.code, errorType } : { err: error, code: normalized.code };
      request.log.error(fields, normalized.message);
    }
    else request.log.info({ code: normalized.code }, normalized.message);
    reply.header("Cache-Control", "no-store");
    if (normalized.retryable) reply.header("Retry-After", "5");
    return reply.status(normalized.statusCode).send({
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        requestId: request.id
      }
    });
  });

  app.addHook("onClose", async () => {
    metrics.serviceUp.set(0);
    await service.close();
  });

  return app;
}

function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (isRateLimitError(error)) {
    return new AppError("RATE_LIMITED", error.error.message, 429, true);
  }
  if (error instanceof ZodError) {
    return new AppError("UPSTREAM_ERROR", "Extracted LinkedIn data did not match the API schema", 502, true, {
      cause: error
    });
  }
  if (isFastifyClientError(error)) {
    return new AppError("INVALID_REQUEST", "Request body validation failed", 400, false, { cause: error });
  }
  return new AppError("INTERNAL_ERROR", "An unexpected error occurred", 500, true, { cause: error });
}

function isRateLimitError(error: unknown): error is { error: { code: "RATE_LIMITED"; message: string } } {
  if (typeof error !== "object" || error === null || !("error" in error)) return false;
  const nested = error.error;
  return (
    typeof nested === "object" &&
    nested !== null &&
    "code" in nested &&
    nested.code === "RATE_LIMITED" &&
    "message" in nested &&
    typeof nested.message === "string"
  );
}

function isFastifyClientError(error: unknown): error is Error & { statusCode?: number; validation?: unknown } {
  if (!(error instanceof Error)) return false;
  if ("validation" in error) return true;
  if (!("statusCode" in error) || error.statusCode !== 400) return false;
  return "code" in error && error.code === "FST_ERR_CTP_INVALID_JSON_BODY";
}
