import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { LinkedInScraper, normalizeJsessionId } from "../src/extractor/linkedin-scraper.js";

const profilePayload = {
  included: [
    {
      $type: "com.linkedin.voyager.identity.profile.Profile",
      entityUrn: "urn:li:fsd_profile:ACoTarget",
      publicIdentifier: "jane-doe",
      firstName: "Jane",
      lastName: "Doe",
      headline: "Staff Engineer"
    }
  ]
};

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_KEYS: "test-key",
    LINKEDIN_LI_AT: "authorized-session-cookie-value",
    LINKEDIN_JSESSIONID: '"ajax:123456"',
    SCRAPE_TIMEOUT_MS: "5000",
    MAX_RETRIES: "0",
    ...overrides
  });
}

describe("LinkedInScraper direct Voyager client", () => {
  it("calls only fixed LinkedIn identity endpoints with the required session headers", async () => {
    const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      expect(headers.get("csrf-token")).toBe("ajax:123456");
      expect(headers.get("cookie")).toContain("li_at=authorized-session-cookie-value");
      expect(headers.get("x-restli-protocol-version")).toBe("2.0.0");
      return Promise.resolve(
        new Response(JSON.stringify(profilePayload), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
    const scraper = new LinkedInScraper(config(), request);

    const result = await scraper.scrape("https://www.linkedin.com/in/jane-doe/");

    expect(result.profile.name).toBe("Jane Doe");
    expect(result.extractionMode).toBe("authenticated");
    expect(request).toHaveBeenCalledTimes(7);
    for (const [input, init] of request.mock.calls) {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
      expect(url.origin).toBe("https://www.linkedin.com");
      expect(url.pathname).toMatch(/^\/voyager\/api\/identity\//);
      expect(init?.redirect).toBe("error");
    }
  });

  it("keeps optional endpoint failures as warnings", async () => {
    let calls = 0;
    const request = vi.fn(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(JSON.stringify(profilePayload), { status: 200 })
          : new Response("not found", { status: 404 })
      );
    });
    const scraper = new LinkedInScraper(config(), request);

    const result = await scraper.scrape("https://www.linkedin.com/in/jane-doe/");

    expect(result.profile.name).toBe("Jane Doe");
    expect(result.warnings).toContain("skills endpoint was unavailable to the configured LinkedIn session");
  });

  it.each([
    [401, "LINKEDIN_SESSION_EXPIRED"],
    [429, "LINKEDIN_BLOCKED"],
    [404, "PROFILE_NOT_FOUND"],
    [503, "UPSTREAM_ERROR"]
  ])("maps HTTP %s to %s", async (status, code) => {
    const request = vi.fn(() => Promise.resolve(new Response("upstream", { status })));
    const scraper = new LinkedInScraper(config(), request);
    await expect(scraper.scrape("https://www.linkedin.com/in/jane-doe/")).rejects.toMatchObject({ code });
  });

  it("rejects oversized and malformed endpoint responses", async () => {
    const oversized = new LinkedInScraper(
      config(),
      vi.fn(() =>
        Promise.resolve(new Response("{}", { status: 200, headers: { "content-length": "2000001" } }))
      )
    );
    await expect(oversized.scrape("https://www.linkedin.com/in/jane-doe/")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR"
    });

    const malformed = new LinkedInScraper(
      config(),
      vi.fn(() => Promise.resolve(new Response("not-json", { status: 200 })))
    );
    await expect(malformed.scrape("https://www.linkedin.com/in/jane-doe/")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR"
    });
  });

  it("fails readiness when endpoint session cookies are absent", () => {
    const scraper = new LinkedInScraper(loadConfig({ NODE_ENV: "test", API_KEYS: "test-key" }));
    expect(() => scraper.checkReady()).toThrow(/LINKEDIN_LI_AT and LINKEDIN_JSESSIONID/);
  });

  it("normalizes quoted JSESSIONID cookie values", () => {
    expect(normalizeJsessionId('"ajax:123"')).toBe("ajax:123");
    expect(normalizeJsessionId("ajax:456")).toBe("ajax:456");
  });
});
