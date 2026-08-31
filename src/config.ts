import { z } from "zod";

const integerFromString = (defaultValue: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: integerFromString(3000, 1, 65_535),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY_HOPS: integerFromString(0, 0, 5),
  API_KEYS: z.string().default(""),
  LINKEDIN_LI_AT: z.string().min(20).optional().or(z.literal("")),
  LINKEDIN_JSESSIONID: z.string().min(3).optional().or(z.literal("")),
  SCRAPE_TIMEOUT_MS: integerFromString(45_000, 5_000, 120_000),
  SCRAPE_CONCURRENCY: integerFromString(2, 1, 10),
  SCRAPE_QUEUE_MAX: integerFromString(20, 0, 1_000),
  CACHE_TTL_SECONDS: integerFromString(3_600, 0, 86_400),
  CACHE_MAX_ENTRIES: integerFromString(500, 1, 10_000),
  CACHE_MAX_VALUE_BYTES: integerFromString(524_288, 1_024, 5_242_880),
  RATE_LIMIT_MAX: integerFromString(30, 1, 10_000),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  MAX_RETRIES: integerFromString(1, 0, 3)
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(environment);
  const apiKeys = parsed.API_KEYS.split(",")
    .map((key) => key.trim())
    .filter(Boolean);

  if (parsed.NODE_ENV === "production" && apiKeys.length === 0) {
    throw new Error("API_KEYS must contain at least one key in production");
  }
  if (
    parsed.NODE_ENV === "production" &&
    apiKeys.some((key) => key.length < 32 || key === "replace-with-a-long-random-key")
  ) {
    throw new Error("Every production API key must be an unpredictable value of at least 32 characters");
  }
  if (parsed.NODE_ENV === "production" && (!parsed.LINKEDIN_LI_AT || !parsed.LINKEDIN_JSESSIONID)) {
    throw new Error("LINKEDIN_LI_AT and LINKEDIN_JSESSIONID are required in production");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    trustProxyHops: parsed.TRUST_PROXY_HOPS,
    apiKeys,
    linkedInLiAt: parsed.LINKEDIN_LI_AT === "" ? undefined : parsed.LINKEDIN_LI_AT,
    linkedInJsessionId: parsed.LINKEDIN_JSESSIONID === "" ? undefined : parsed.LINKEDIN_JSESSIONID,
    scrapeTimeoutMs: parsed.SCRAPE_TIMEOUT_MS,
    scrapeConcurrency: parsed.SCRAPE_CONCURRENCY,
    scrapeQueueMax: parsed.SCRAPE_QUEUE_MAX,
    cacheTtlSeconds: parsed.CACHE_TTL_SECONDS,
    cacheMaxEntries: parsed.CACHE_MAX_ENTRIES,
    cacheMaxValueBytes: parsed.CACHE_MAX_VALUE_BYTES,
    rateLimitMax: parsed.RATE_LIMIT_MAX,
    rateLimitWindow: parsed.RATE_LIMIT_WINDOW,
    maxRetries: parsed.MAX_RETRIES
  };
}
