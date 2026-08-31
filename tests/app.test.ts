import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { AppError } from "../src/domain/errors.js";
import type { ProfileScraper } from "../src/extractor/types.js";

class FakeScraper implements ProfileScraper {
  public calls = 0;
  public scrape(profileUrl: string) {
    this.calls += 1;
    return Promise.resolve({
      profile: {
        profileUrl,
        name: "Jane Doe",
        headline: "Staff Software Engineer",
        location: "Bengaluru, India",
        experience: [],
        education: [],
        skills: ["TypeScript"],
        certifications: [],
        languages: []
      },
      extractionMode: "authenticated" as const,
      warnings: ["Some optional fields were unavailable"]
    });
  }
  public close(): Promise<void> {
    return Promise.resolve();
  }
  public checkReady(): Promise<void> {
    return Promise.resolve();
  }
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup(
  apiKeys = "test-key",
  scraper: ProfileScraper = new FakeScraper(),
  extra: NodeJS.ProcessEnv = {}
) {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "silent", API_KEYS: apiKeys, ...extra });
  const app = await buildApp({ config, scraper });
  apps.push(app);
  return { app, scraper };
}

describe("POST /v1/profiles", () => {
  it("requires a configured API key", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      payload: { profileUrl: "https://www.linkedin.com/in/jane-doe/" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("returns a stable contract and a cache result", async () => {
    const { app, scraper } = await setup();
    const request = {
      method: "POST" as const,
      url: "/v1/profiles",
      headers: { "x-api-key": "test-key" },
      payload: { profileUrl: "https://in.linkedin.com/in/jane-doe?trk=test" }
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      data: { profileUrl: "https://www.linkedin.com/in/jane-doe/", name: "Jane Doe" },
      meta: { cache: "miss", extractionMode: "authenticated", completeness: 40 }
    });
    expect(second.json<{ meta: { cache: string } }>().meta.cache).toBe("hit");
    expect((scraper as FakeScraper).calls).toBe(1);
  });

  it("rejects non-profile and non-LinkedIn URLs before scraping", async () => {
    const { app, scraper } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: { "x-api-key": "test-key" },
      payload: { profileUrl: "https://example.com/in/jane-doe" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_PROFILE_URL");
    expect((scraper as FakeScraper).calls).toBe(0);
  });

  it("normalizes upstream errors and includes retry guidance", async () => {
    const scraper: ProfileScraper = {
      scrape: () => Promise.reject(new AppError("LINKEDIN_BLOCKED", "Upstream blocked", 503, true)),
      checkReady: () => Promise.resolve(),
      close: () => Promise.resolve()
    };
    const { app } = await setup("test-key", scraper);
    const response = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: { "x-api-key": "test-key" },
      payload: { profileUrl: "https://www.linkedin.com/in/jane-doe/" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json<{ error: { code: string } }>().error.code).toBe("LINKEDIN_BLOCKED");
  });

  it("serves health and protected metrics endpoints", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health/ready" })).json()).toMatchObject({
      status: "ok"
    });
    expect((await app.inject({ url: "/metrics" })).statusCode).toBe(401);
    const metrics = await app.inject({ url: "/metrics", headers: { "x-api-key": "test-key" } });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain("linkedin_profile_api_up 1");
  });

  it("rejects unknown routes and malformed bodies", async () => {
    const { app } = await setup("");
    expect((await app.inject({ url: "/missing" })).json<{ error: { code: string } }>().error.code).toBe(
      "INVALID_REQUEST"
    );
    const malformed = await app.inject({ method: "POST", url: "/v1/profiles", payload: {} });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("INVALID_REQUEST");

    const invalidJson = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: { "content-type": "application/json" },
      payload: '{"profileUrl":'
    });
    expect(invalidJson.statusCode).toBe(400);
    expect(invalidJson.json<{ error: { code: string } }>().error.code).toBe("INVALID_REQUEST");
  });

  it("reports endpoint-client readiness failures without failing liveness", async () => {
    const scraper: ProfileScraper = {
      scrape: () => Promise.reject(new Error("not used")),
      checkReady: () => Promise.reject(new Error("LinkedIn session unavailable")),
      close: () => Promise.resolve()
    };
    const { app } = await setup("test-key", scraper);

    expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(503);
  });

  it("enforces the configured client rate limit", async () => {
    const { app } = await setup("test-key", new FakeScraper(), { RATE_LIMIT_MAX: "1" });
    const request = {
      method: "POST" as const,
      url: "/v1/profiles",
      headers: { "x-api-key": "test-key" },
      payload: { profileUrl: "https://www.linkedin.com/in/jane-doe/" }
    };

    expect((await app.inject(request)).statusCode).toBe(200);
    const limited = await app.inject({
      ...request,
      headers: { ...request.headers, "x-forwarded-for": "203.0.113.77" }
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ error: { code: string; requestId: string } }>().error).toMatchObject({
      code: "RATE_LIMITED"
    });
  });
});

describe("configuration", () => {
  it("requires API keys in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", API_KEYS: "" })).toThrow(/API_KEYS/);
  });

  it("rejects weak production keys and missing endpoint session cookies", () => {
    expect(() => loadConfig({ NODE_ENV: "production", API_KEYS: "too-short" })).toThrow(/32 characters/);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        API_KEYS: "this-is-a-valid-production-api-key-value",
        LINKEDIN_LI_AT: "authorized-session-cookie-value"
      })
    ).toThrow(/LINKEDIN_JSESSIONID/);
  });
});
