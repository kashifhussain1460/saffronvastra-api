# API error contract and code catalogue

Every error response from `/api/v1` has this shape (added centrally in `src/app.ts`, so every module follows it):

```json
{ "status": "error", "code": "VALIDATION_ERROR", "message": "Readable text for the user", "requestId": "…" }
```

- `code` is stable: clients branch on it, never on `message`.
- `message` is safe to show. For 500 responses it is always the generic text; the real cause is in the server log
  under the same `requestId`.
- Extra fields stay where modules already send them (for example `errors` from zod validation with per-field detail,
  `usage` on a blocked media delete). Clients must tolerate unknown fields.
- `requestId` is also sent as the `x-request-id` header; quote it when reporting a problem.

## Generic codes (added when a module does not set its own)

| HTTP | Code | Meaning | Retry? | Client action |
|---|---|---|---|---|
| 400 | VALIDATION_ERROR | Input failed validation | No | Show field messages, keep the user's input |
| 401 | UNAUTHORIZED | No valid session | No | Send to sign-in with a redirect back |
| 403 | FORBIDDEN | Signed in but not allowed | No | Explain; do not retry |
| 404 | NOT_FOUND | Record or route does not exist (or is not visible to this user) | No | Show not-found state |
| 409 | CONFLICT | State changed or duplicate (slug, code, stale list) | No (reload first) | Reload data, show message |
| 413 | PAYLOAD_TOO_LARGE | Upload over the limit | No | Ask for a smaller file |
| 429 | RATE_LIMITED | Too many requests | Yes, later | Wait, then allow retry |
| 500 | INTERNAL_SERVER_ERROR | Unexpected failure | Yes (once) | Generic message + reference |
| 502 | (module code) | An outside service failed (email provider) | Yes | Show message, allow retry |
| 503 | (module code) | Service temporarily unavailable | Yes | Show retry |

## Module codes

| Code | HTTP | Module | Meaning |
|---|---|---|---|
| EMAIL_ALREADY_EXISTS | 409 | auth | Signup with an email that has an account |
| AUTH_RATE_LIMIT_EXCEEDED | 429 | auth | Login/signup/reset/verification attempts limited per visitor |
| INVALID_RESET_TOKEN | 400 | auth | Reset link invalid, expired or used |
| INVALID_VERIFICATION_TOKEN | 400 | auth | Verification link invalid, expired or used |
| VERIFICATION_COOLDOWN | 429 | auth | A new verification link was requested within a minute |
| ADMIN_CANNOT_ORDER | 403 | orders | Administrator accounts cannot place orders |
| CHECKOUT_RATE_LIMIT_EXCEEDED | 429 | orders | Too many checkout attempts |
| RATE_LIMIT_EXCEEDED | 429 | api | General request limit |
| ALREADY_REVIEWED | 409 | reviews | One review per product per customer |
| NOT_A_PURCHASER | 403 | reviews | Only customers with a delivered order may review |
| SESSION_NOT_FOUND | 404 | analytics | Unknown tracking session |
| INVALID_EVENTS_PAYLOAD | 400 | analytics | Malformed analytics batch |
| ANALYTICS_*_FAILED | 500 | analytics | Analytics query failed (message replaced by the generic text) |

Logging severity: 4xx are expected and not logged as errors (security-relevant ones go to the audit trail:
`LOGIN_FAILED`, `ADMIN_ACCESS_DENIED`); 5xx are logged with the request id.
