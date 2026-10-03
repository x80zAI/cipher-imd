# Verification record

Verified on 4 October 2026. CIPHER IMD contains real service integrations, an empty request form, real public network data and visitor-owned request history. No seeded orders, invented answers, fabricated activity or simulated payment controls are shipped.

## Local checks

- TypeScript: passed.
- ESLint: passed.
- Automated checks: 102 passed in three files. These cover route restrictions, request validation, input/body limits, private caching, payment resource binding, unchanged signature forwarding, artifact integrity, reviewed quote validation, SDK signing compatibility and safe order exports.
- Production build: passed with Vite 8.3.2 and Node 24.18.0.
- Installed dependency audit: zero reported vulnerabilities at verification time.
- Desktop and 390 x 844 mobile layouts: inspected in Chrome; no horizontal document overflow.
- Consultation and report controls, request review, consent gate, local history, public job lookup, directory search and pagination: checked in the browser.
- No application console error observed. Installed browser wallet extensions emitted their own unrelated warnings.

## Actual IMD service checks

- Capabilities and public network routes returned successful live responses.
- A real unpaid consultation quote returned HTTP 201 and its payment challenge returned HTTP 402.
- The actual challenge passed the production payment validator with the official Ethereum network, IMD asset, current recipient and exact quoted amount of 0.5 IMD.
- IMD currently identifies the payment resource as `https://api.imd.fun/requests/{id}`. The original URL is preserved in both signatures; the documented `/submit` alternative is also restricted to the same official order.
- Public job `0860e448-e960-43af-9a1c-5eed9019ef04` was read through the interface and its actual report downloaded through the same-origin API.
- Downloaded report: 28,920 bytes. SHA-256: `920d7ff88e39d280dde9788bc6fce0d7940ff77c35645bccc0fdde1d14a9948d`, matching the job result metadata and original content.
- Ethereum RPC reads confirmed that the official IMD asset, Permit2 and payment proxy contracts have deployed code. No wallet secrets were used.

## Boundaries

No real wallet approval, payment signature, token transfer or paid admission was executed during verification. Signing compatibility is covered by isolated automated tests; current quote compatibility is checked against the real service. A visitor must personally review and authorize an order to verify a paid run with their wallet.

IMD operates the agent execution service. Availability, delivery time, correctness and successful completion depend on that service and its agents. The interface reports actual states, errors and public results. Requests and results are public; clearing browser storage removes local unpaid-order access.

## Hosting

The source is configured for GitHub and Vercel. The same server handler supports local Vite and Vercel functions. No server wallet, OpenAI credential, database or additional Cloudflare service is needed. Custom domain and X account remain pending David's supplied details.
