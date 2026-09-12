# LogosBibleSoftwareMCP — code review

Reviewed on **2026-09-12**. Repository: [CyberCwby/LogosBibleSoftwareMCP](https://github.com/CyberCwby/LogosBibleSoftwareMCP).

Snapshot: `main` at [`54687c85789807ea61c788391764b13b8097975a`](https://github.com/CyberCwby/LogosBibleSoftwareMCP/commit/54687c85789807ea61c788391764b13b8097975a). Scope: current default-branch code, including existing defects.

**Result: 1 finding — P2.** Priorities: P1 = high, P2 = medium, P3 = low.

## [P2] Bound the time spent honoring Biblia Retry-After responses

**Location:** [logos-mcp-server/src/services/biblia-api.ts:142–146](https://github.com/CyberCwby/LogosBibleSoftwareMCP/blob/54687c85789807ea61c788391764b13b8097975a/logos-mcp-server/src/services/biblia-api.ts#L142-L146).

**Status:** Previously documented as M3 in the [docs/CODE_REVIEW-2026-08-25.md](https://github.com/CyberCwby/LogosBibleSoftwareMCP/blob/54687c85789807ea61c788391764b13b8097975a/docs/CODE_REVIEW-2026-08-25.md) review; confirmed still present.

The 429 branch uses the server-provided `Retry-After` value directly as a sleep duration. A retry-count limit bounds the number of requests, but it does not bound how long an interactive MCP tool call remains pending. A response asking the client to wait an hour can cause two one-hour sleeps before the structured rate-limit error is returned.

**Reproduction:** Called the actual `getBibleText` implementation with a fake 429 response carrying `Retry-After: 3600`. Intercepted timers recorded:

```json
{"requests":3,"requestedDelaysMs":[3600000,3600000]}
```

No real network request or hour-long wait occurred.

**Suggested fix:** Enforce an overall request budget. When the requested delay exceeds the remaining budget, return the existing structured `rate_limited` error with retry guidance immediately. Apply a bounded policy to both numeric and date-form headers, and include fetch/body time in the overall deadline.

**Regression coverage to add:** Very large numeric and future-date values must return within the configured budget; short retry delays should still work. The client should receive usable retry information without holding a tool call open indefinitely.

## Validation and scope

Reviewed the TypeScript services, reference parsing, SQLite/catalog access, launch/UI automation paths, error handling, and their tests. The reproduction used the actual Biblia service with controlled fetch and timers.

The full Vitest suite was not run because package dependencies were unavailable. Windows/macOS Logos integration, local Logos databases, PowerShell/UI Automation, and the live Biblia API were not exercised.
