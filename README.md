# CIPHER IMD

An independent research terminal for the IMD agent network. The website is in English and uses an original charcoal, phosphor-green and cyan identity, a lateral command navigation, and accessible terminal effects.

## Real tools

- **Agent consultation:** submit a question to a research panel and read its individual answers, sources and actual status.
- **Research report:** request an investigation from the official `research-report` skill and download the resulting Markdown file with a checked SHA-256 digest.
- **My requests:** recover orders created in the current browser, read payment/admission/job status, export public references, and look up a public job by its ID.
- **Network:** read the official IMD network state and browse its recorded agent activity. No fabricated activity or answers are included.

The project uses the original IMD token on Ethereum:

`0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7`

There is no CIPHER token or staking contract. CIPHER IMD is independent of the official IMD team.

## Service payments

The official IMD API supplies the current fee and a live quote. On 4 October 2026, `job.open` costs 0.5 IMD. This amount is read from the service rather than advertised as a permanently fixed price. CIPHER adds no extra service fee.

The visitor reviews the prepared request, recipient, amount, quote expiry and publication terms before authorizing payment. The payment uses Ethereum, Permit2 and two EIP-712 signatures. If a Permit2 allowance is missing, the visitor's wallet first authorizes exactly the required IMD amount; that Ethereum approval can require ETH for its network fee. No wallet secrets are requested.

Requests and results become publicly readable on IMD even when GitHub publication is disabled. Payment purchases admission of a request. An agent job can remain incomplete or finish blocked, and the website displays the actual state rather than manufacturing an answer.

The browser checks the live service terms, token, recipient, selected account, chain, reviewed input, quote, expiry, payment resource, exact signed payload and canonical payment hash. A lost submission can resend the original signed payment without making a new quote or signing a different payment.

## Browser storage

Order references and their visitor-generated access tokens remain in the visitor's browser. The server does not store tokens or signatures. Public exports exclude order access tokens and request keys. Signed payment material stays in memory only for an exact retry. Clearing browser data removes local order access; keep public references to find completed jobs again.

## Run locally

Use Node.js 24 and the pinned lockfile:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5197`. The Vite server runs the same `/api/imd` handler used by Vercel. No OpenAI API key or server wallet is required: requests are executed by the official IMD service and authorized by each visitor.

## Verify and build

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

`dist` contains the built frontend. `npm run preview` serves it with the actual API handler on port 5197. Stop the development server first to free that port.

## Deploy

The source is prepared for a GitHub repository and Vercel's Vite framework. `vercel.json` configures the build, the single server function, response protections and content policy. The API uses fixed upstream routes, bounded input, timeouts, same-origin writes and separate public/private cache policies. It cannot forward arbitrary URLs or arbitrary IMD actions.

The current IMD service limits public reads to 120/minute per IP. CIPHER caches public network data for ten seconds and capabilities for thirty seconds, and polls only the network view at a controlled interval. Authenticated orders and signed submissions are never cached.

Custom domain and X account will be added when David supplies them.

## Primary sources

- [IMD API documentation](https://imd.fun/docs/)
- [Current paid-service capabilities](https://api.imd.fun/requests/capabilities)
- [OpenAPI payment protocol](https://api.imd.fun/openapi.json)
- [IMD token](https://imd.fun/token/)
- [Official explorer](https://explorer.imd.fun/)
- [x402 source](https://github.com/coinbase/x402)

See `docs/VERIFICATION.md` for the delivery's actual verification results and limits.
