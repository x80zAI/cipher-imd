# CIPHER IMD API

`api/imd.mjs` is the same Node request handler in Vercel and the local Vite server. Every upstream request uses the fixed HTTPS origin `https://api.imd.fun`; the client cannot supply an upstream URL. The handler has no operator credentials, wallet keys or autonomous payment code.

## Public reads

| Request | Parameters | Official upstream |
| --- | --- | --- |
| `GET /api/imd?op=capabilities` | None | `/requests/capabilities` |
| `GET /api/imd?op=network` | None | `/swarm` |
| `GET /api/imd?op=jobs` | Optional `q` (up to 200 characters), `limit` (1–30, default 20), ISO `before` cursor | `/jobs` |
| `GET /api/imd?op=job` | `id`: job UUID | `/jobs/:id` |
| `GET /api/imd?op=panel` | `id`: job UUID | `/jobs/:id/panel` |
| `GET /api/imd?op=result` | `id`: job UUID | `/jobs/:id/result` |
| `GET /api/imd?op=submissions` | `id`: job UUID | `/jobs/:id/submissions` |
| `GET /api/imd?op=paid-by` | `address`: Ethereum wallet address | `/requests/paid-by/:address` |
| `GET /api/imd?op=artifact` | `id`: job UUID; `hash`: 64 hexadecimal SHA-256 characters | Recorded report file only |

Only unauthenticated public reads can enter the in-process cache. Capabilities expire after 30 seconds; other JSON reads after 10 seconds. Errors, writes and authenticated responses use `Cache-Control: no-store`.

The artifact handler first fetches `/jobs/:id/result`. It requires the selected hash to belong to `report`, `artifacts/report.md`, with `mediaType: text/markdown`, matching file size and a fixed official artifact URL. It then downloads `/artifacts/:hash`, refuses redirects, limits the file to 2 MiB, verifies SHA-256 and UTF-8, and returns a Markdown attachment named `cipher-imd-report.md`. The official artifact route currently delivers these files as `application/octet-stream`; that type is accepted only after the metadata check. HTML document formats are refused. Verified downloads may be cached externally; download bytes are not retained in the in-process cache.

## Requests and payment

All POST calls require an `Origin` matching this website's host: HTTPS in hosting, HTTP for loopback Vite. Cross-origin browser writes and unsupported methods are refused. Browser Origin, cookies and Referer are not forwarded upstream. The proxy does not enable CORS.

`Authorization: Bearer <64 hex characters>` is required for quote, challenge, submit and order status. This is the visitor's client-generated request identifier, not an operator API key. It is forwarded only to those official request routes and is never logged or cached.

| Operation | Request body | Upstream |
| --- | --- | --- |
| `POST ?op=check` | `action`, `input` | `/requests/check` |
| `POST ?op=quote` | `requestKey` UUID, `action`, `input` | `/requests/quote` |
| `POST ?op=challenge&id=:uuid` | No body, or empty JSON object | `/requests/:id/submit` without a body |
| `POST ?op=submit&id=:uuid` | Only `quoteSignature`; also `PAYMENT-SIGNATURE` header | `/requests/:id/submit` |
| `GET ?op=order&id=:uuid` | None | `/requests/:id` |

The only accepted action is `job.open`. Research inputs must set `github:false`, `minCitations` from 0 to 20, and one of:

- Consultation: `template:research`, nonempty `objective` up to 4,000 characters, `panelSize` from 1 to 9, and `panelQuorum` from 1 to `panelSize`.
- Report: `skill:research-report`, nonempty `objective` up to 8,000 characters, and exactly one output: name `report`, path `artifacts/report.md`, media type `text/markdown`.

Additional input fields, deployment, token creation, staking, GitHub publication and other action types are refused. Request bodies are limited to 16 KiB of UTF-8 JSON. Submit validates the quote signature and strict x402/Permit2 payment shape, Ethereum network, original IMD token and agreement of payment fields. The official service remains responsible for verifying the wallet signatures, the saved quote, expiration, payment and admission.

Successful JSON and the 402 x402 challenge are returned intact; `PAYMENT-REQUIRED` is preserved. Pending status remains pending. The proxy never repeats a payment submission automatically. Upstream error responses retain safe error information and `Retry-After`; stack traces and known request secrets are removed. Redirects, invalid upstream data and network errors become sanitized JSON errors. Upstream calls share a 12-second timeout, including both metadata and file reads for a download.

## Verification boundary

Security and payment tests use isolated upstream replies and test signatures. They do not sign with a real wallet or charge IMD. Live GET verification on 4 October 2026 confirmed capabilities, public network state and a recorded Markdown download after metadata, hash and encoding checks. No paid request was executed during backend verification.

Official references: [IMD API documentation](https://imd.fun/docs/), [live capabilities](https://api.imd.fun/requests/capabilities), [OpenAPI](https://api.imd.fun/openapi.json).
