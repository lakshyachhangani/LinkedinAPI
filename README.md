# LinkedIn Profile API

A production-oriented HTTP API that accepts a LinkedIn profile URL and returns structured profile JSON. The extractor is a **pure reverse-engineered HTTP client**: it calls LinkedIn's private Voyager identity endpoints directly and does **not** use Playwright, Selenium, Chromium, DOM rendering, or browser automation.

> This project is not affiliated with LinkedIn and does not use an official LinkedIn API. LinkedIn's private endpoints and session-cookie use are undocumented and may be restricted by its terms. Operate only with an account you control, written authorization, and a lawful basis for processing profile data. No CAPTCHA bypass, proxy rotation, credential collection, or account automation is included.

## Tech stack

| Area | Technology | Purpose |
|---|---|---|
| Runtime | Node.js 22, TypeScript | Typed server-side implementation and native `fetch` |
| API | Fastify 5 | HTTP routing, validation, lifecycle, and request IDs |
| Validation | Zod + Fastify JSON Schema | Validates configuration, extracted profiles, and public contracts |
| Security | API-key digests, Helmet, rate limiting | Protects the public service and avoids logging secrets |
| Reliability | Semaphore, retries, deadlines, LRU cache | Bounds LinkedIn traffic, queues work, and coalesces duplicate requests |
| Observability | Pino, Prometheus metrics, health probes | Structured logs and operational signals |
| Testing | Vitest + V8 coverage | Deterministic endpoint fixtures without live LinkedIn calls |
| Delivery | Docker, GitHub Actions, CodeQL, Dependabot, Render | Reproducible builds, security checks, and HTTPS deployment |

## Reverse-engineered approach

The input URL is normalized to `https://www.linkedin.com/in/{publicIdentifier}/`. The service then issues server-side `GET` requests to a fixed allowlist under:

```text
https://www.linkedin.com/voyager/api/identity/
```

The client requests these observed Voyager resources when available:

```text
/voyager/api/identity/profiles/{publicIdentifier}
/voyager/api/identity/profiles/{publicIdentifier}/profileView
/voyager/api/identity/profiles/{publicIdentifier}/positions
/voyager/api/identity/profiles/{publicIdentifier}/educations
/voyager/api/identity/profiles/{publicIdentifier}/skills
/voyager/api/identity/profiles/{publicIdentifier}/certifications
/voyager/api/identity/profiles/{publicIdentifier}/languages
```

Requests reproduce the relevant web-client protocol headers: `csrf-token`, `x-restli-protocol-version`, `x-li-lang`, `x-li-track`, normalized JSON `Accept`, and the authorized `li_at`/`JSESSIONID` cookies. Only the first-party HTTPS origin and `/voyager/api/identity/` path are constructible by the client, so user input cannot select an arbitrary upstream host.

Voyager responses commonly contain normalized `included` entities. The mapper recursively collects bounded JSON objects, identifies the profile whose `publicIdentifier` matches the requested URL, scopes related entities to that member URN, deduplicates them, maps images and date ranges, and validates the result before returning it.

### Request flow

1. Validate API key, JSON body, URL scheme, hostname, port, and `/in/` path.
2. Normalize the profile URL and check the bounded TTL cache.
3. Coalesce simultaneous requests for the same profile.
4. Acquire the bounded extraction semaphore.
5. Call the fixed Voyager endpoint allowlist with an overall deadline.
6. Translate upstream `401`, `403`, `404`, `429`, and `5xx` responses into stable API errors.
7. Reject redirects, oversized bodies, and malformed JSON.
8. Map only entities associated with the requested profile and validate the response.
9. Cache the result and return metadata, warnings, and completeness.

## Repository layout

```text
src/api/                         API authentication and JSON schemas
src/domain/                      Profile model and stable error taxonomy
src/extractor/linkedin-scraper.ts Direct Voyager HTTP client
src/extractor/voyager.ts         Normalized response/entity mapper
src/extractor/mapper.ts          Public profile assembly and validation
src/service/profile-service.ts   Cache and in-flight request coalescing
src/observability/               Prometheus metrics
tests/                           Deterministic unit and API tests
.github/workflows/               CI and CodeQL
Dockerfile / render.yaml         Container and HTTPS deployment
```

## Local setup

Requirements: Node.js 22+, Corepack, and a LinkedIn session you are authorized to use.

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Generate a client-facing API key:

```bash
openssl rand -base64 32
```

Set that value as `API_KEYS` in `.env`.

Sign in to LinkedIn normally in a browser. In developer tools, open **Application → Cookies → https://www.linkedin.com** and copy the `li_at` and `JSESSIONID` values into your local `.env`:

```dotenv
LINKEDIN_LI_AT=your_li_at_value
LINKEDIN_JSESSIONID=ajax:your_csrf_value
```

Quotes around `JSESSIONID` are accepted and stripped. Never commit `.env`, cookies, passwords, or API keys. The API accepts only a profile URL; it never accepts LinkedIn credentials from callers.

Run checks and start the service:

```bash
pnpm check
pnpm dev
```

Local endpoints:

```text
http://localhost:3000/health/live
http://localhost:3000/health/ready
http://localhost:3000/documentation
```

## API documentation

### `POST /v1/profiles`

Headers:

```http
Content-Type: application/json
X-API-Key: your-client-api-key
```

Body:

```json
{
  "profileUrl": "https://www.linkedin.com/in/example-person/",
  "refresh": false
}
```

Example:

```bash
curl --request POST 'http://localhost:3000/v1/profiles' \
  --header 'Content-Type: application/json' \
  --header "X-API-Key: ${LINKEDIN_API_KEY}" \
  --data '{"profileUrl":"https://www.linkedin.com/in/example-person/"}'
```

Example response:

```json
{
  "data": {
    "profileUrl": "https://www.linkedin.com/in/example-person/",
    "name": "Example Person",
    "headline": "Staff Software Engineer",
    "location": "Bengaluru, India",
    "about": "I build reliable systems.",
    "profileImageUrl": "https://media.licdn.com/example.jpg",
    "experience": [
      {
        "title": "Staff Software Engineer",
        "company": "Example Corp",
        "dateRange": { "startDate": "2022-01" },
        "skills": []
      }
    ],
    "education": [],
    "skills": ["TypeScript"],
    "certifications": [],
    "languages": []
  },
  "meta": {
    "requestId": "9b8624a4-3f02-4c3d-b584-74a0c5bb6e44",
    "fetchedAt": "2026-08-31T17:00:00.000Z",
    "cache": "miss",
    "extractionMode": "authenticated",
    "completeness": 70,
    "warnings": []
  }
}
```

`refresh: true` bypasses a completed cache entry. Simultaneous requests remain coalesced.

### Other endpoints

| Endpoint | Authentication | Purpose |
|---|---|---|
| `GET /health/live` | None | Process liveness |
| `GET /health/ready` | None | Configuration readiness |
| `GET /documentation` | None | Swagger UI |
| `GET /documentation/json` | None | OpenAPI document |
| `GET /metrics` | `X-API-Key` | Prometheus metrics |

### Error model

```json
{
  "error": {
    "code": "LINKEDIN_SESSION_EXPIRED",
    "message": "LinkedIn rejected the configured session cookies",
    "retryable": false,
    "requestId": "5ccf14dd-29b8-4ba7-930d-8a89aca353de"
  }
}
```

| Code | HTTP | Meaning |
|---|---:|---|
| `INVALID_PROFILE_URL` / `INVALID_REQUEST` | 400 | Invalid input |
| `UNAUTHORIZED` | 401 | Missing or incorrect service API key |
| `PROFILE_NOT_FOUND` | 404 | Profile or required upstream resource missing |
| `RATE_LIMITED` | 429 | Client rate limit exceeded |
| `UPSTREAM_ERROR` | 502 | LinkedIn network, server, JSON, or size failure |
| `LINKEDIN_AUTH_REQUIRED` / `LINKEDIN_SESSION_EXPIRED` / `LINKEDIN_BLOCKED` | 503 | Missing, expired, or restricted LinkedIn session |
| `SCRAPE_CAPACITY_EXCEEDED` | 503 | Endpoint request queue is full |
| `SCRAPE_TIMEOUT` | 504 | Overall endpoint deadline expired |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Runtime mode |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Listener |
| `API_KEYS` | empty | Comma-separated client API keys; required in production |
| `LINKEDIN_LI_AT` | empty | Secret authorized LinkedIn session cookie; required in production |
| `LINKEDIN_JSESSIONID` | empty | Secret LinkedIn CSRF/session cookie; required in production |
| `SCRAPE_TIMEOUT_MS` | `45000` | Overall Voyager extraction deadline |
| `SCRAPE_CONCURRENCY` | `2` | Concurrent profile extractions per instance |
| `SCRAPE_QUEUE_MAX` | `20` | Maximum waiting requests |
| `MAX_RETRIES` | `1` | Retry count for transient `5xx`/network failures |
| `CACHE_TTL_SECONDS` | `3600` | Successful response cache lifetime |
| `CACHE_MAX_ENTRIES` | `500` | Maximum cached profiles |
| `CACHE_MAX_VALUE_BYTES` | `524288` | Maximum cached serialized response size |
| `RATE_LIMIT_MAX` | `30` | Requests per client window |
| `RATE_LIMIT_WINDOW` | `1 minute` | Rate-limit window |

## Deploy over HTTPS with Render

`render.yaml` defines a Docker web service. Render terminates TLS and generates the client-facing `API_KEYS` secret. It deliberately requires the two LinkedIn cookies as manually entered secrets.

1. Push this repository and wait for CI and CodeQL on `main`.
2. In Render choose **New → Blueprint** and connect this repository.
3. Enter `LINKEDIN_LI_AT` and `LINKEDIN_JSESSIONID` when the Blueprint requests them.
4. Apply the Blueprint and wait for `/health/ready` to pass.
5. Read the generated `API_KEYS` secret from Render and test one profile you control.
6. Keep all secrets in Render's environment settings, never in Git or Docker build arguments.

The free plan is suitable for a time-limited challenge demo but may sleep and cold-start. A sustained deployment should use a non-sleeping instance.

## Production safeguards

- Strict LinkedIn HTTPS `/in/` URL validation before upstream work.
- Fixed first-party Voyager identity endpoint allowlist; no user-controlled upstream URLs.
- API keys compared by SHA-256 digest with timing-safe equality.
- Session cookies and caller API keys redacted from logs.
- Redirect rejection, response byte limits, JSON limits, hard deadline, bounded queue, and limited retries.
- In-flight request coalescing and size-bounded TTL cache reduce LinkedIn traffic.
- Non-root, read-only-capable container with liveness/readiness probes.
- Pinned lockfile, CI, CodeQL, and Dependabot configuration.

## Known limitations

- Voyager is private and unsupported. Endpoint paths, headers, entity names, and response shapes may change without notice.
- `li_at` and `JSESSIONID` expire, can be revoked, and may trigger account verification. This project does not automate login or checkpoints.
- Visible fields depend on the authenticated account, target privacy settings, geography, and LinkedIn experiments.
- Optional endpoint failures return partial data plus warnings instead of failing the whole profile.
- The mapper intentionally ignores entities not tied to the requested member URN to prevent viewer-data leakage.
- Cache and rate limiting are in-process. Multi-instance production should use Redis and a durable, per-account request budget.
- Running a public profile extraction service carries privacy, contractual, and regulatory obligations not solved by the code alone.

## License

MIT. See [LICENSE](LICENSE).
