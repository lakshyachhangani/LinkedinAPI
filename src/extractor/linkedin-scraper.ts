import type { Config } from "../config.js";
import { AppError, isAppError } from "../domain/errors.js";
import { Semaphore } from "../lib/semaphore.js";
import { mapExtraction } from "./mapper.js";
import type { ProfileScraper, ScrapeOutput } from "./types.js";

const LINKEDIN_API_ORIGIN = "https://www.linkedin.com";
const MAX_RESPONSE_BYTES = 2_000_000;

interface Endpoint {
  name: string;
  path: (publicIdentifier: string) => string;
  required: boolean;
}

const ENDPOINTS: readonly Endpoint[] = [
  { name: "profile", path: (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}`, required: true },
  {
    name: "profile view",
    path: (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/profileView`,
    required: false
  },
  {
    name: "experience",
    path: (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/positions`,
    required: false
  },
  {
    name: "education",
    path: (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/educations`,
    required: false
  },
  { name: "skills", path: (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/skills`, required: false },
  {
    name: "certifications",
    path: (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/certifications`,
    required: false
  },
  {
    name: "languages",
    path: (id) => `/voyager/api/identity/profiles/${encodeURIComponent(id)}/languages`,
    required: false
  }
];

export class LinkedInScraper implements ProfileScraper {
  private readonly semaphore: Semaphore;

  public constructor(
    private readonly config: Config,
    private readonly request: typeof fetch = fetch
  ) {
    this.semaphore = new Semaphore(config.scrapeConcurrency, config.scrapeQueueMax);
  }

  public async scrape(profileUrl: string): Promise<ScrapeOutput> {
    this.assertSessionConfigured();
    const deadline = Date.now() + this.config.scrapeTimeoutMs;
    const release = await this.semaphore.acquire(Math.min(remainingMs(deadline), 10_000));
    try {
      return await this.scrapeWithRetries(profileUrl, deadline);
    } finally {
      release();
    }
  }

  public checkReady(): Promise<void> {
    this.assertSessionConfigured();
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private async scrapeWithRetries(profileUrl: string, deadline: number): Promise<ScrapeOutput> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await this.scrapeOnce(profileUrl, deadline);
      } catch (error) {
        lastError = error;
        const retryable = isAppError(error) && error.retryable && error.code === "UPSTREAM_ERROR";
        if (!retryable || attempt === this.config.maxRetries || remainingMs(deadline) <= 250) throw error;
        await delay(Math.min(250 * 2 ** attempt, remainingMs(deadline)));
      }
    }
    throw lastError;
  }

  private async scrapeOnce(profileUrl: string, deadline: number): Promise<ScrapeOutput> {
    const publicIdentifier = decodeURIComponent(new URL(profileUrl).pathname.split("/").filter(Boolean).at(-1) ?? "");
    const payloads: unknown[] = [];
    const warnings: string[] = [];

    for (const endpoint of ENDPOINTS) {
      try {
        payloads.push(await this.fetchEndpoint(endpoint.path(publicIdentifier), deadline));
      } catch (error) {
        if (endpoint.required || isFatalSessionError(error)) throw error;
        warnings.push(`${endpoint.name} endpoint was unavailable to the configured LinkedIn session`);
      }
    }

    return mapExtraction({ profileUrl, voyagerPayloads: payloads, warnings });
  }

  private async fetchEndpoint(path: string, deadline: number): Promise<unknown> {
    assertTimeRemaining(deadline);
    const url = new URL(path, LINKEDIN_API_ORIGIN);
    if (url.origin !== LINKEDIN_API_ORIGIN || !url.pathname.startsWith("/voyager/api/identity/")) {
      throw new AppError("INTERNAL_ERROR", "LinkedIn endpoint allowlist violation", 500);
    }

    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(remainingMs(deadline)),
        headers: this.headers()
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new AppError("SCRAPE_TIMEOUT", "LinkedIn endpoint extraction exceeded its time limit", 504, true, {
          cause: error
        });
      }
      throw new AppError("UPSTREAM_ERROR", "LinkedIn endpoint request failed", 502, true, { cause: error });
    }

    if (response.status === 401) {
      throw new AppError("LINKEDIN_SESSION_EXPIRED", "LinkedIn rejected the configured session cookies", 503);
    }
    if (response.status === 403 || response.status === 429 || response.status === 999) {
      throw new AppError("LINKEDIN_BLOCKED", `LinkedIn rejected the endpoint request with HTTP ${response.status}`, 503);
    }
    if (response.status === 404) {
      throw new AppError("PROFILE_NOT_FOUND", "LinkedIn profile or endpoint was not found", 404);
    }
    if (response.status >= 500) {
      throw new AppError("UPSTREAM_ERROR", `LinkedIn returned HTTP ${response.status}`, 502, true);
    }
    if (!response.ok) {
      throw new AppError("UPSTREAM_ERROR", `LinkedIn returned HTTP ${response.status}`, 502);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_RESPONSE_BYTES) {
      throw new AppError("UPSTREAM_ERROR", "LinkedIn endpoint response exceeded the size limit", 502);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new AppError("UPSTREAM_ERROR", "LinkedIn endpoint response exceeded the size limit", 502);
    }
    try {
      return JSON.parse(body.toString("utf8")) as unknown;
    } catch (error) {
      throw new AppError("UPSTREAM_ERROR", "LinkedIn endpoint returned invalid JSON", 502, true, { cause: error });
    }
  }

  private headers(): Headers {
    const csrfToken = normalizeJsessionId(this.config.linkedInJsessionId ?? "");
    const headers = new Headers({
      accept: "application/vnd.linkedin.normalized+json+2.1",
      "accept-language": "en-US,en;q=0.9",
      "csrf-token": csrfToken,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "x-li-lang": "en_US",
      "x-restli-protocol-version": "2.0.0",
      "x-li-track": JSON.stringify({
        clientVersion: "1.13.32100",
        mpVersion: "1.13.32100",
        osName: "web",
        timezoneOffset: 0,
        timezone: "UTC",
        deviceFormFactor: "DESKTOP",
        mpName: "voyager-web"
      })
    });
    headers.set(
      "cookie",
      `li_at=${this.config.linkedInLiAt ?? ""}; JSESSIONID="${csrfToken}"; lang=v=2&lang=en-us`
    );
    return headers;
  }

  private assertSessionConfigured(): void {
    if (!this.config.linkedInLiAt || !this.config.linkedInJsessionId) {
      throw new AppError(
        "LINKEDIN_AUTH_REQUIRED",
        "LINKEDIN_LI_AT and LINKEDIN_JSESSIONID must be configured for direct Voyager requests",
        503
      );
    }
  }
}

export function normalizeJsessionId(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function assertTimeRemaining(deadline: number): void {
  if (remainingMs(deadline) <= 0) {
    throw new AppError("SCRAPE_TIMEOUT", "LinkedIn endpoint extraction exceeded its time limit", 504, true);
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

function isFatalSessionError(error: unknown): boolean {
  return (
    isAppError(error) &&
    ["LINKEDIN_AUTH_REQUIRED", "LINKEDIN_SESSION_EXPIRED", "LINKEDIN_BLOCKED", "SCRAPE_TIMEOUT"].includes(error.code)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
