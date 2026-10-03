import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createHandler } from '../api/imd.mjs';

// All upstream replies and signatures in this file are isolated test inputs.
const ID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'ab'.repeat(32);
const AUTH = `Bearer ${TOKEN}`;
const SIG = `0x${'12'.repeat(65)}`;
const IMD = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7';
const WALLET = `0x${'34'.repeat(20)}`;
const PAY_TO = `0x${'56'.repeat(20)}`;
const research = () => ({ objective: 'Research this supplied question with reliable sources.', template: 'research', panelSize: 5, panelQuorum: 3, minCitations: 3, github: false });
const report = () => ({ objective: 'Prepare a sourced report for this supplied question.', skill: 'research-report', minCitations: 5, github: false, outputs: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' }] });
const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function payment() {
  return {
    x402Version: 2,
    resource: { url: `https://api.imd.fun/requests/${ID}/submit`, description: 'Research request', mimeType: 'application/json' },
    accepted: { scheme: 'exact', network: 'eip155:1', asset: IMD, amount: '500000000000000000', payTo: PAY_TO, maxTimeoutSeconds: 600, extra: { assetTransferMethod: 'permit2' } },
    payload: { signature: SIG, permit2Authorization: { from: WALLET, permitted: { token: IMD, amount: '500000000000000000' }, spender: `0x${'78'.repeat(20)}`, nonce: '4', deadline: '1791070000', witness: { to: PAY_TO, validAfter: '0' } } },
  };
}
const encoded = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64');

function request({ op = 'capabilities', query = '', method = 'GET', body, raw, parsed, headers = {} }: {
  op?: string; query?: string; method?: string; body?: unknown; raw?: string | Buffer; parsed?: unknown; headers?: Record<string, string>;
} = {}) {
  const data = raw ?? (body === undefined ? '' : JSON.stringify(body));
  const req = Readable.from(data.length ? [data] : []) as Readable & { url: string; method: string; headers: Record<string, string>; body?: unknown };
  req.url = `/api/imd?op=${op}${query}`;
  req.method = method;
  req.headers = { host: 'cipher.example', ...(method === 'POST' ? { origin: 'https://cipher.example', 'content-type': 'application/json' } : {}), ...headers };
  if (parsed !== undefined) req.body = parsed;
  return req;
}

function response() {
  const headers = new Map<string, string>();
  let bytes = Buffer.alloc(0);
  return {
    statusCode: 200,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    end(value: string | Uint8Array) { bytes = Buffer.from(value); },
    headers,
    get raw() { return bytes; },
    get json() { return JSON.parse(bytes.toString('utf8')); },
  };
}

async function run(req: ReturnType<typeof request>, fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ ok: true }))) {
  const res = response();
  await createHandler({ fetchImpl })(req, res);
  return { res, fetchImpl };
}

describe('fixed upstream routes and request restrictions', () => {
  it.each([
    ['capabilities', '', '/requests/capabilities'], ['network', '', '/swarm'], ['jobs', '&q=token%20analysis&limit=12', '/jobs?limit=12&q=token+analysis'],
    ['job', `&id=${ID}`, `/jobs/${ID}`], ['panel', `&id=${ID}`, `/jobs/${ID}/panel`], ['result', `&id=${ID}`, `/jobs/${ID}/result`],
    ['submissions', `&id=${ID}`, `/jobs/${ID}/submissions`], ['paid-by', `&address=${WALLET}`, `/requests/paid-by/${WALLET}`],
  ])('maps %s to its fixed HTTPS route', async (op, query, path) => {
    const { res, fetchImpl } = await run(request({ op, query }));
    expect(res.statusCode).toBe(200);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.imd.fun${path}`);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: 'application/json' } });
  });

  it.each([
    ['unknown', ''], ['launch', ''], ['staking', ''], ['capabilities', '&url=https://evil.example'], ['capabilities', '&op=network'],
    ['job', '&id=../../requests/quote'], ['job', '&id=invalid'], ['order', '&id=invalid'], ['paid-by', '&address=not-a-wallet'],
    ['jobs', '&limit=31'], ['jobs', '&limit=0'], ['jobs', '&limit=1.5'], ['jobs', `&q=${'x'.repeat(201)}`], ['jobs', '&before=invalid'],
  ])('refuses invalid parameters before contacting IMD: %s %s', async (op, query) => {
    const { res, fetchImpl } = await run(request({ op, query }));
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses absolute URLs and paths that cannot be proxy operations', async () => {
    for (const url of ['https://evil.example/?op=capabilities', '/api/imd/../../requests/quote?op=quote', '/other?op=capabilities']) {
      const req = request(); req.url = url;
      const { res, fetchImpl } = await run(req);
      expect(res.statusCode).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it.each(['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'])('does not forward %s', async (method) => {
    const { res, fetchImpl } = await run(request({ method }));
    expect(res.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(res.headers.has('access-control-allow-origin')).toBe(false);
  });

  it('does not turn a read into a write or a write into a read', async () => {
    expect((await run(request({ op: 'capabilities', method: 'POST', body: {} }))).res.statusCode).toBe(405);
    expect((await run(request({ op: 'quote' }))).res.statusCode).toBe(405);
  });
});

describe('same-origin writes and restricted research inputs', () => {
  it.each(['https://evil.example', 'null', 'http://cipher.example', 'https://cipher.example.evil.example', ''])('blocks a foreign or missing POST origin: %s', async (origin) => {
    const { res, fetchImpl } = await run(request({ op: 'check', method: 'POST', body: { action: 'job.open', input: research() }, headers: { origin } }));
    expect(res.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks cross-site browser requests even if the Origin header matches', async () => {
    const { res, fetchImpl } = await run(request({ op: 'check', method: 'POST', body: { action: 'job.open', input: research() }, headers: { 'sec-fetch-site': 'cross-site' } }));
    expect(res.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('supports loopback Vite with the same request handler', async () => {
    const req = request({ op: 'check', method: 'POST', body: { action: 'job.open', input: research() }, headers: { host: '127.0.0.1:5197', origin: 'http://127.0.0.1:5197' } });
    req.url = '/?op=check';
    const { res, fetchImpl } = await run(req);
    expect(res.statusCode).toBe(200);
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Origin');
  });

  it.each([research, report])('passes an allowed research input without forwarding browser credentials', async (input) => {
    const body = { action: 'job.open', input: input() };
    const { res, fetchImpl } = await run(request({ op: 'check', method: 'POST', body, headers: { authorization: AUTH, cookie: 'private=value', referer: 'https://cipher.example/' } }));
    expect(res.statusCode).toBe(200);
    const init = fetchImpl.mock.calls[0][1];
    expect(init?.body).toBe(JSON.stringify(body));
    expect(init?.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    { action: 'launch.open', input: research() }, { action: 'oracle.request', input: research() }, { action: 'job.open', input: { ...research(), onchain: true } },
    { action: 'job.open', input: { ...research(), github: true } }, { action: 'job.open', input: { ...research(), ipfs: true } },
    { action: 'job.open', input: { ...research(), skill: 'implement-contract' } }, { action: 'job.open', input: { ...research(), steps: [{ skill: 'deploy-script' }] } },
    { action: 'job.open', input: { ...research(), panelQuorum: 6 } }, { action: 'job.open', input: { ...research(), panelSize: 10 } },
    { action: 'job.open', input: { ...report(), outputs: [{ name: 'report', path: '../../private.txt', mediaType: 'text/markdown' }] } },
    { action: 'job.open', input: { ...research(), objective: ' ' } }, { action: 'job.open', input: { ...research(), minCitations: 21 } },
    { action: 'job.open', input: { ...report(), objective: 'x'.repeat(8001) } }, { action: 'job.open', input: research(), url: 'https://evil.example' },
  ])('refuses unsupported actions and input fields before any write', async (body) => {
    const { res, fetchImpl } = await run(request({ op: 'check', method: 'POST', body }));
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a raw or Vercel-parsed body larger than 16 KiB', async () => {
    for (const req of [request({ op: 'check', method: 'POST', raw: 'x'.repeat(16385) }), request({ op: 'check', method: 'POST', parsed: { value: 'x'.repeat(16385) } }), request({ op: 'check', method: 'POST', headers: { 'content-length': '16385' } })]) {
      const { res, fetchImpl } = await run(req);
      expect(res.statusCode).toBe(413);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed JSON and unsupported media types', async () => {
    expect((await run(request({ op: 'check', method: 'POST', raw: '{broken' }))).res.statusCode).toBe(400);
    expect((await run(request({ op: 'check', method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } }))).res.statusCode).toBe(415);
  });
});

describe('wallet payment flow', () => {
  it.each(['quote', 'challenge', 'submit', 'order'])('requires a request bearer for %s', async (op) => {
    const { res, fetchImpl } = await run(request({ op, query: op === 'quote' ? '' : `&id=${ID}`, method: op === 'order' ? 'GET' : 'POST' }));
    expect(res.statusCode).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards an authenticated quote with its request key and exact input', async () => {
    const body = { requestKey: ID, action: 'job.open', input: research() };
    const { res, fetchImpl } = await run(request({ op: 'quote', method: 'POST', body, headers: { authorization: AUTH } }));
    expect(res.statusCode).toBe(200);
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty('Authorization', AUTH);
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify(body));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('preserves a 402 challenge, payment header and prepared input', async () => {
    const challenge = { x402Version: 2, quote: { id: ID }, resourceUrl: `https://api.imd.fun/requests/${ID}/submit`, requesterScopeHash: 'a'.repeat(64), input: research(), accepts: [{ amount: '500000000000000000' }] };
    const required = encoded(challenge);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(challenge, 402, { 'PAYMENT-REQUIRED': required }));
    const { res } = await run(request({ op: 'challenge', query: `&id=${ID}`, method: 'POST', headers: { authorization: AUTH } }), fetchImpl);
    expect(res.statusCode).toBe(402);
    expect(res.json).toEqual(challenge);
    expect(res.headers.get('payment-required')).toBe(required);
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('body');
  });

  it('supports Vercel null for an absent challenge body without sending a payment or body', async () => {
    const challenge = { x402Version: 2, resourceUrl: `https://api.imd.fun/requests/${ID}` };
    const required = encoded(challenge);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(challenge, 402, { 'PAYMENT-REQUIRED': required }));
    const req = request({ op: 'challenge', query: `&id=${ID}`, method: 'POST', parsed: null, headers: { authorization: AUTH } });
    delete req.headers['content-type'];
    const { res } = await run(req, fetchImpl);
    expect(res.statusCode).toBe(402);
    expect(res.json).toEqual(challenge);
    expect(res.headers.get('payment-required')).toBe(required);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty('body');
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('PAYMENT-SIGNATURE');
  });

  it('does not allow the challenge operation to submit a payment', async () => {
    const { res, fetchImpl } = await run(request({ op: 'challenge', query: `&id=${ID}`, method: 'POST', body: { quoteSignature: SIG }, headers: { authorization: AUTH, 'payment-signature': encoded(payment()) } }));
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards exactly one reviewed payment submission and preserves pending status', async () => {
    const payload = encoded(payment());
    const admitted = { status: 'payment_pending', order: { id: ID }, payment: { paid: false } };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(admitted, 202));
    const { res } = await run(request({ op: 'submit', query: `&id=${ID}`, method: 'POST', body: { quoteSignature: SIG }, headers: { authorization: AUTH, 'payment-signature': payload } }), fetchImpl);
    expect(res.statusCode).toBe(202);
    expect(res.json).toEqual(admitted);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty('PAYMENT-SIGNATURE', payload);
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify({ quoteSignature: SIG }));
  });

  it('accepts the current official order resource without changing the SDK payment bytes', async () => {
    const value = payment();
    value.resource.url = `https://api.imd.fun/requests/${ID}`;
    const payload = encoded(value);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ status: 'payment_pending' }, 202));
    const { res } = await run(request({ op: 'submit', query: `&id=${ID}`, method: 'POST', body: { quoteSignature: SIG }, headers: { authorization: AUTH, 'payment-signature': payload } }), fetchImpl);
    expect(res.statusCode).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.headers).toHaveProperty('PAYMENT-SIGNATURE', payload);
  });

  it.each([`https://api.imd.fun/requests/${ID}?redirect=1`, `https://api.imd.fun/requests/${ID}/submit?redirect=1`, `https://api.imd.fun.evil.example/requests/${ID}`])('rejects modified resource URLs: %s', async (url) => {
    const value = payment(); value.resource.url = url;
    const { res, fetchImpl } = await run(request({ op: 'submit', query: `&id=${ID}`, method: 'POST', body: { quoteSignature: SIG }, headers: { authorization: AUTH, 'payment-signature': encoded(value) } }));
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['missing', 'invalid-base64', 'different-token', 'different-recipient', 'different-order', 'unknown-field', 'extensions', 'numeric-asset'])('refuses malformed or unexpected payment data: %s', async (kind) => {
    const value = payment();
    if (kind === 'different-token') value.accepted.asset = `0x${'99'.repeat(20)}`;
    if (kind === 'different-recipient') value.payload.permit2Authorization.witness.to = WALLET;
    if (kind === 'different-order') value.resource.url = 'https://evil.example/submit';
    const extra = kind === 'unknown-field' ? { ...value, externalUrl: 'https://evil.example' } : kind === 'extensions' ? { ...value, extensions: { unsupported: true } } : kind === 'numeric-asset' ? { ...value, accepted: { ...value.accepted, asset: 10 } } : value;
    const headers: Record<string, string> = { authorization: AUTH };
    if (kind !== 'missing') headers['payment-signature'] = kind === 'invalid-base64' ? '%%%' : encoded(extra);
    const { res, fetchImpl } = await run(request({ op: 'submit', query: `&id=${ID}`, method: 'POST', body: { quoteSignature: SIG }, headers }));
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an invalid quote signature and never starts payment', async () => {
    const { res, fetchImpl } = await run(request({ op: 'submit', query: `&id=${ID}`, method: 'POST', body: { quoteSignature: '0x12' }, headers: { authorization: AUTH, 'payment-signature': encoded(payment()) } }));
    expect(res.statusCode).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('cache isolation, errors and timeouts', () => {
  it('caches only public reads, expires them and never forwards optional credentials', async () => {
    let now = 1000;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ at: now }));
    const handler = createHandler({ fetchImpl, now: () => now });
    for (let i = 0; i < 2; i++) await handler(request(), response());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const privateRead = response();
    await handler(request({ headers: { authorization: AUTH } }), privateRead);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]?.headers).not.toHaveProperty('Authorization');
    expect(privateRead.headers.get('cache-control')).toBe('no-store');
    now += 31000;
    await handler(request(), response());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never caches orders, including separate bearer sessions', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ status: 'quoted' }));
    const handler = createHandler({ fetchImpl });
    for (const token of [AUTH, AUTH, `Bearer ${'cd'.repeat(32)}`]) {
      const res = response(); await handler(request({ op: 'order', query: `&id=${ID}`, headers: { authorization: token } }), res);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('preserves Retry-After while dropping internal fields and redacting secrets', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: 'request_limit', detail: `secret ${TOKEN}`, message: `Rejected ${AUTH}`, stack: 'internal stack', database: 'private' }, 429, { 'Retry-After': '20' }));
    const { res } = await run(request({ op: 'order', query: `&id=${ID}`, headers: { authorization: AUTH } }), fetchImpl);
    expect(res.statusCode).toBe(429);
    expect(res.headers.get('retry-after')).toBe('20');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.raw.toString()).not.toContain(TOKEN);
    expect(res.json).not.toHaveProperty('stack');
    expect(res.json).not.toHaveProperty('database');
  });

  it('sanitizes a network exception without revealing its text', async () => {
    const { res } = await run(request(), vi.fn<typeof fetch>().mockRejectedValue(new Error(`private ${TOKEN}`)));
    expect(res.statusCode).toBe(502);
    expect(res.json.error).toBe('imd_unavailable');
    expect(res.raw.toString()).not.toContain(TOKEN);
  });

  it('aborts a stalled upstream request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('private timeout information', 'AbortError')), { once: true });
    }));
    const res = response();
    await createHandler({ fetchImpl, timeoutMs: 10 })(request(), res);
    expect(res.statusCode).toBe(504);
    expect(res.json.error).toBe('imd_timeout');
  });

  it('refuses redirects and non-JSON upstream responses', async () => {
    for (const upstream of [new Response('', { status: 307, headers: { Location: 'https://evil.example' } }), new Response('<html>private error</html>', { status: 502 })]) {
      const { res } = await run(request(), vi.fn<typeof fetch>().mockResolvedValue(upstream));
      expect(res.statusCode).toBe(502);
      expect(res.raw.toString()).not.toContain('private error');
    }
  });
});

describe('real report download restrictions', () => {
  const bytes = Buffer.from('# Research report\n\nSources and findings.\n');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const manifest = (fileHash = hash, byteLength = bytes.length) => ({ jobId: ID, state: 'completed', complete: true, files: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown', hash: fileHash, bytes: byteLength, url: `https://api.imd.fun/artifacts/${fileHash}` }] });

  it('downloads hash-verified Markdown as an attachment from a fixed artifact route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(manifest())).mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    const { res } = await run(request({ op: 'artifact', query: `&id=${ID}&hash=${hash}` }), fetchImpl);
    expect(res.statusCode).toBe(200);
    expect(res.raw).toEqual(bytes);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="cipher-imd-report.md"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.imd.fun/jobs/${ID}/result`);
    expect(fetchImpl.mock.calls[1][0]).toBe(`https://api.imd.fun/artifacts/${hash}`);
  });

  it('refuses a hash, MIME type or path absent from the selected job metadata', async () => {
    const missingHash = manifest('a'.repeat(64));
    const wrongType = manifest(); wrongType.files[0].mediaType = 'text/html';
    const wrongPath = manifest(); wrongPath.files[0].path = 'artifacts/image.svg';
    for (const metadata of [missingHash, wrongType, wrongPath]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(metadata));
      const { res } = await run(request({ op: 'artifact', query: `&id=${ID}&hash=${hash}` }), fetchImpl);
      expect(res.statusCode).toBe(400);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('rejects path injection and arbitrary download URLs', async () => {
    for (const query of [`&id=${ID}&hash=../secret`, `&id=${ID}&hash=https://evil.example`, `&id=${ID}&hash=${hash}&url=https://evil.example`, `&hash=${hash}`]) {
      const { res, fetchImpl } = await run(request({ op: 'artifact', query }));
      expect(res.statusCode).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('rejects a mismatched hash, HTML, invalid UTF-8 and files above 2 MiB', async () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe]);
    const cases = [
      { data: bytes, hash: 'a'.repeat(64), type: 'text/plain' },
      { data: bytes, hash, type: 'text/html' },
      { data: Buffer.from('<html><script>unsafe()</script></html>'), hash: createHash('sha256').update('<html><script>unsafe()</script></html>').digest('hex'), type: 'text/plain' },
      { data: invalidUtf8, hash: createHash('sha256').update(invalidUtf8).digest('hex'), type: 'text/plain' },
      { data: bytes, hash, type: 'text/plain', length: String(2 * 1024 * 1024 + 1) },
    ];
    for (const entry of cases) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(manifest(entry.hash, entry.data.length))).mockResolvedValueOnce(new Response(entry.data, { headers: { 'Content-Type': entry.type, ...(entry.length ? { 'Content-Length': entry.length } : {}) } }));
      const { res } = await run(request({ op: 'artifact', query: `&id=${ID}&hash=${entry.hash}` }), fetchImpl);
      expect(res.statusCode).toBe(502);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });
});
