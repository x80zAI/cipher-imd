import { createHash } from 'node:crypto';

const UPSTREAM = 'https://api.imd.fun';
const IMD = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7';
const BODY_LIMIT = 16 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const GET_OPS = new Set(['capabilities', 'network', 'jobs', 'job', 'panel', 'result', 'submissions', 'order', 'paid-by', 'artifact']);
const POST_OPS = new Set(['check', 'quote', 'challenge', 'submit']);
const PRIVATE_OPS = new Set(['quote', 'challenge', 'submit', 'order']);

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message = 'This request is not supported.') => {
  throw new RequestError(400, 'invalid_request', message);
};
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.includes(key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const textValue = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const uint = (value) => (typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value))
  || (Number.isSafeInteger(value) && value >= 0);

function header(req, name) {
  const value = req.headers?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || /[\r\n]/.test(value)) invalid('A request header is invalid.');
  return value;
}

function checkOrigin(req, method) {
  const host = header(req, 'host');
  if (!host || !/^(?:[a-z0-9.-]+|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) invalid('The website host is invalid.');
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host);
  const expected = `${local ? 'http' : 'https'}://${host.toLowerCase()}`;
  const origin = header(req, 'origin');
  if ((method === 'POST' && !origin) || (origin !== undefined && origin !== expected)) {
    throw new RequestError(403, 'origin_not_allowed', 'Send this request from the CIPHER IMD website.');
  }
  const site = header(req, 'sec-fetch-site');
  if (method === 'POST' && site && !['same-origin', 'none'].includes(site)) {
    throw new RequestError(403, 'origin_not_allowed', 'Send this request from the CIPHER IMD website.');
  }
}

function bearer(req, required) {
  const authorization = header(req, 'authorization');
  if (!authorization) {
    if (required) throw new RequestError(401, 'request_token_required', 'Your request session is missing. Please start again.');
    return undefined;
  }
  if (!/^Bearer [0-9a-f]{64}$/i.test(authorization)) {
    throw new RequestError(401, 'invalid_request_token', 'Your request session is invalid. Please start again.');
  }
  return authorization;
}

function route(req, method) {
  let url;
  try { url = new URL(req.url ?? '/', 'https://cipher.invalid'); } catch { invalid(); }
  if (!['/', '/api/imd'].includes(url.pathname) || url.origin !== 'https://cipher.invalid') invalid();
  const op = url.searchParams.get('op');
  const known = GET_OPS.has(op) || POST_OPS.has(op);
  if (!known) invalid('Choose a supported CIPHER IMD operation.');
  if ((GET_OPS.has(op) && method !== 'GET') || (POST_OPS.has(op) && method !== 'POST')) {
    throw new RequestError(405, 'method_not_allowed', 'This operation does not accept that method.');
  }
  const allowed = op === 'jobs' ? ['op', 'q', 'limit', 'before']
    : ['job', 'panel', 'result', 'submissions', 'order', 'challenge', 'submit'].includes(op) ? ['op', 'id']
      : op === 'paid-by' ? ['op', 'address'] : op === 'artifact' ? ['op', 'id', 'hash'] : ['op'];
  const seen = new Set();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) invalid('An operation parameter is invalid.');
    seen.add(key);
  }
  const id = url.searchParams.get('id');
  if (allowed.includes('id') && !UUID.test(id ?? '')) invalid('A valid request or job identifier is required.');
  let path;
  if (op === 'capabilities') path = '/requests/capabilities';
  else if (op === 'network') path = '/swarm';
  else if (op === 'jobs') {
    const q = url.searchParams.get('q');
    const rawLimit = url.searchParams.get('limit') ?? '20';
    const before = url.searchParams.get('before');
    if ((q !== null && q.length > 200) || !/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > 30) invalid('Search text or page size is invalid.');
    if (before !== null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(before) || !Number.isFinite(Date.parse(before)))) invalid('The page cursor is invalid.');
    const query = new URLSearchParams({ limit: rawLimit });
    if (q) query.set('q', q);
    if (before) query.set('before', before);
    path = `/jobs?${query}`;
  } else if (['job', 'panel', 'result', 'submissions'].includes(op)) {
    path = `/jobs/${id.toLowerCase()}${op === 'job' ? '' : `/${op}`}`;
  } else if (op === 'artifact') {
    const hash = url.searchParams.get('hash');
    if (!/^[0-9a-f]{64}$/i.test(hash ?? '')) invalid('A valid report hash is required.');
    path = `/artifacts/${hash.toLowerCase()}`;
  } else if (op === 'order') path = `/requests/${id.toLowerCase()}`;
  else if (op === 'paid-by') {
    const address = url.searchParams.get('address');
    if (!ADDRESS.test(address ?? '')) invalid('A valid wallet address is required.');
    path = `/requests/paid-by/${address.toLowerCase()}`;
  } else if (['check', 'quote'].includes(op)) path = `/requests/${op}`;
  else path = `/requests/${id.toLowerCase()}/submit`;
  return { op, id, hash: url.searchParams.get('hash')?.toLowerCase(), url: `${UPSTREAM}${path}` };
}

async function readBody(req) {
  const length = header(req, 'content-length');
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > BODY_LIMIT)) {
    throw new RequestError(413, 'body_too_large', 'Requests must fit within 16 KiB.');
  }
  let raw;
  if (req.body !== undefined) {
    raw = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body));
  } else {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > BODY_LIMIT) throw new RequestError(413, 'body_too_large', 'Requests must fit within 16 KiB.');
      chunks.push(part);
    }
    raw = Buffer.concat(chunks);
  }
  if (raw.length > BODY_LIMIT) throw new RequestError(413, 'body_too_large', 'Requests must fit within 16 KiB.');
  if (!raw.length) return undefined;
  try { return JSON.parse(raw.toString('utf8')); } catch { invalid('Send a valid JSON request.'); }
}

function researchInput(input) {
  if (!record(input) || input.github !== false || !integer(input.minCitations, 0, 20)) invalid('Only public research requests without GitHub publication are supported.');
  if (input.template === 'research') {
    if (!keysOnly(input, ['objective', 'template', 'panelSize', 'panelQuorum', 'minCitations', 'github'])
      || !textValue(input.objective, 4000) || !integer(input.panelSize, 1, 9)
      || !integer(input.panelQuorum, 1, input.panelSize)) invalid('The research panel settings are invalid.');
  } else if (input.skill === 'research-report') {
    if (!keysOnly(input, ['objective', 'skill', 'outputs', 'minCitations', 'github']) || !textValue(input.objective, 8000)
      || !Array.isArray(input.outputs) || input.outputs.length !== 1
      || !keysOnly(input.outputs[0], ['name', 'path', 'mediaType'])
      || input.outputs[0].name !== 'report' || input.outputs[0].path !== 'artifacts/report.md'
      || input.outputs[0].mediaType !== 'text/markdown') invalid('The research report settings are invalid.');
  } else invalid('Only agent consultations and research reports are supported.');
}

function checkPaymentHeader(value, id) {
  if (typeof value !== 'string' || value.length > 12288 || value.length < 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid('The payment authorization is invalid.');
  let payment;
  try { payment = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { invalid('The payment authorization is invalid.'); }
  const accepted = payment?.accepted;
  const permit = payment?.payload?.permit2Authorization;
  if (!keysOnly(payment, ['x402Version', 'resource', 'accepted', 'payload', 'extensions']) || payment.x402Version !== 2
    || !keysOnly(accepted, ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra'])
    || accepted.scheme !== 'exact' || accepted.network !== 'eip155:1' || typeof accepted.asset !== 'string' || accepted.asset.toLowerCase() !== IMD
    || !uint(accepted.amount) || BigInt(accepted.amount) === 0n || !ADDRESS.test(accepted.payTo ?? '')
    || !integer(accepted.maxTimeoutSeconds, 1, 3600)
    || !keysOnly(accepted.extra, ['assetTransferMethod']) || accepted.extra.assetTransferMethod !== 'permit2'
    || !keysOnly(payment.payload, ['signature', 'permit2Authorization']) || !SIGNATURE.test(payment.payload.signature ?? '')
    || !keysOnly(permit, ['from', 'permitted', 'spender', 'nonce', 'deadline', 'witness'])
    || !ADDRESS.test(permit.from ?? '') || !ADDRESS.test(permit.spender ?? '') || !uint(permit.nonce) || !uint(permit.deadline)
    || !keysOnly(permit.permitted, ['token', 'amount']) || typeof permit.permitted.token !== 'string' || permit.permitted.token.toLowerCase() !== IMD
    || String(permit.permitted.amount) !== String(accepted.amount)
    || !keysOnly(permit.witness, ['to', 'validAfter']) || typeof permit.witness.to !== 'string' || permit.witness.to.toLowerCase() !== accepted.payTo.toLowerCase()
    || !uint(permit.witness.validAfter)) invalid('The payment authorization does not match an IMD request.');
  if (payment.extensions !== undefined && (!record(payment.extensions) || Object.keys(payment.extensions).length)) invalid('Payment extensions are not supported.');
  const orderResource = `${UPSTREAM}/requests/${id.toLowerCase()}`;
  if (payment.resource !== undefined && (!keysOnly(payment.resource, ['url', 'description', 'mimeType'])
    || ![orderResource, `${orderResource}/submit`].includes(payment.resource.url)
    || (payment.resource.description !== undefined && !textValue(payment.resource.description, 2000))
    || (payment.resource.mimeType !== undefined && !textValue(payment.resource.mimeType, 100)))) invalid('The payment belongs to a different request.');
}

function postBody(op, body, req, id) {
  const payment = header(req, 'payment-signature');
  if (op !== 'submit' && payment !== undefined) invalid('Payment authorization is only accepted when submitting a reviewed request.');
  if (op === 'challenge') {
    if (body !== undefined && (!record(body) || Object.keys(body).length)) invalid('The payment challenge does not accept an input body.');
    return undefined;
  }
  if (op === 'submit') {
    if (!keysOnly(body, ['quoteSignature']) || !SIGNATURE.test(body.quoteSignature ?? '')) invalid('A valid quote approval is required.');
    checkPaymentHeader(payment, id);
    return JSON.stringify(body);
  }
  const allowed = op === 'quote' ? ['action', 'input', 'requestKey'] : ['action', 'input'];
  if (!keysOnly(body, allowed) || body.action !== 'job.open') invalid('Only agent consultations and research reports are supported.');
  if (op === 'quote' && !UUID.test(body.requestKey ?? '')) invalid('A valid request key is required.');
  researchInput(body.input);
  return JSON.stringify(body);
}

async function upstreamBytes(response, limit = RESPONSE_LIMIT) {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) throw new RequestError(502, 'upstream_response_invalid', 'The IMD service returned an oversized response.');
  const reader = response.body?.getReader();
  const chunks = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > limit) {
          await reader.cancel();
          throw new RequestError(502, 'upstream_response_invalid', 'The IMD service returned an oversized response.');
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally { reader.releaseLock(); }
  } else {
    const raw = Buffer.from(await response.text());
    if (raw.length > limit) throw new RequestError(502, 'upstream_response_invalid', 'The IMD service returned an oversized response.');
    chunks.push(raw);
  }
  return Buffer.concat(chunks);
}

async function upstreamBody(response) {
  try {
    const payload = JSON.parse((await upstreamBytes(response)).toString('utf8'));
    if (!record(payload) && !Array.isArray(payload)) throw new Error();
    return payload;
  } catch (error) {
    if (error instanceof RequestError || error?.name === 'AbortError') throw error;
    throw new RequestError(502, 'upstream_response_invalid', 'The IMD service returned an invalid response. Please try again.');
  }
}

async function reportBytes(response, hash, expectedBytes) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['text/markdown', 'text/plain', 'application/octet-stream'].includes(type)) throw new RequestError(502, 'invalid_report_type', 'The IMD service did not return a Markdown report.');
  const bytes = await upstreamBytes(response, 2 * 1024 * 1024);
  if (bytes.length !== expectedBytes) throw new RequestError(502, 'report_metadata_mismatch', 'The report does not match its recorded file size.');
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new RequestError(502, 'report_hash_mismatch', 'The report failed its file integrity check. Please try again later.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new RequestError(502, 'invalid_report_encoding', 'The report is not valid UTF-8 text.'); }
  if (text.includes('\0') || /<(?:!doctype\s+html|html|script|iframe|object|embed)(?:\s|>)/i.test(text)) {
    throw new RequestError(502, 'invalid_report_type', 'The report contains an unsupported document format.');
  }
  return bytes;
}

async function reportMetadata(fetchImpl, target, signal) {
  const response = await fetchImpl(`${UPSTREAM}/jobs/${target.id.toLowerCase()}/result`, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal });
  if (response.redirected || (response.status >= 300 && response.status < 400)) throw new RequestError(502, 'upstream_redirect_refused', 'The IMD service redirected this request. Please try again later.');
  if (response.status !== 200) throw new RequestError(response.status >= 400 ? response.status : 502, 'report_not_available', 'The requested research result is not available. Please try again later.');
  const metadata = await upstreamBody(response);
  const file = Array.isArray(metadata.files) ? metadata.files.find((entry) => entry?.hash === target.hash) : undefined;
  if (metadata.jobId?.toLowerCase() !== target.id.toLowerCase() || !record(file) || file.name !== 'report'
    || file.path !== 'artifacts/report.md' || file.mediaType !== 'text/markdown'
    || !integer(file.bytes, 0, 2 * 1024 * 1024)
    || ![`${UPSTREAM}/artifacts/${target.hash}`, `/artifacts/${target.hash}`].includes(file.url)) {
    throw new RequestError(400, 'report_metadata_mismatch', 'This file is not a recorded Markdown report for the selected research job.');
  }
  return file;
}

function respondReport(res, bytes, cacheable) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cipher-imd-report.md"');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', cacheable ? 'public, max-age=0, s-maxage=3600' : 'no-store');
  res.setHeader('Vary', 'Authorization, Origin');
  res.end(bytes);
}

function sanitizeError(payload, secrets) {
  const cleanText = (value, max = 1000) => {
    let result = typeof value === 'string' ? value : '';
    for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]');
    // eslint-disable-next-line no-control-regex -- Remove control bytes from upstream error text.
    return result.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  };
  const result = {
    error: cleanText(payload.error, 100) || 'imd_request_failed',
    message: cleanText(payload.message, 500) || 'The IMD service could not complete this request.',
  };
  if (typeof payload.detail === 'string') result.detail = cleanText(payload.detail);
  if (typeof payload.reason === 'string') result.reason = cleanText(payload.reason, 200);
  for (const name of ['problems', 'blockers', 'suggestions']) {
    if (Array.isArray(payload[name])) result[name] = payload[name].slice(0, 30).map((entry) => {
      if (typeof entry === 'string') return cleanText(entry);
      if (!record(entry)) return 'The service refused part of the request.';
      return Object.fromEntries(['code', 'message', 'detail', 'path', 'severity'].filter((key) => typeof entry[key] === 'string').map((key) => [key, cleanText(entry[key])]));
    });
  }
  return result;
}

function respond(res, status, payload, cacheSeconds = 0, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheSeconds ? `public, max-age=0, s-maxage=${cacheSeconds}` : 'no-store');
  res.setHeader('Vary', 'Authorization, Origin');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

/** One handler for Vercel and Vite. The cache never contains authenticated responses. */
export function createHandler({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 12000 } = {}) {
  const cache = new Map();
  return async function handler(req, res) {
    let timeout;
    let quoteSignature;
    try {
      const method = req.method ?? 'GET';
      if (!['GET', 'POST'].includes(method)) throw new RequestError(405, 'method_not_allowed', 'Only GET and POST are supported.');
      checkOrigin(req, method);
      const target = route(req, method);
      const authorization = bearer(req, PRIVATE_OPS.has(target.op));
      const cacheable = method === 'GET' && !authorization && !PRIVATE_OPS.has(target.op);
      const ttl = target.op === 'capabilities' ? 30 : 10;
      const cached = cacheable && target.op !== 'artifact' ? cache.get(target.url) : undefined;
      if (cached && cached.expires > now()) { respond(res, 200, cached.payload, ttl); return; }
      let body;
      if (method === 'POST') {
        const contentType = header(req, 'content-type');
        if ((target.op !== 'challenge' || contentType !== undefined) && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType ?? '')) {
          throw new RequestError(415, 'unsupported_media_type', 'Send this request as JSON.');
        }
        const parsedBody = await readBody(req);
        quoteSignature = typeof parsedBody?.quoteSignature === 'string' ? parsedBody.quoteSignature : undefined;
        body = postBody(target.op, parsedBody, req, target.id);
      }
      const headers = { Accept: target.op === 'artifact' ? 'text/markdown, text/plain' : 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (PRIVATE_OPS.has(target.op)) headers.Authorization = authorization;
      const paymentSignature = header(req, 'payment-signature');
      if (target.op === 'submit') headers['PAYMENT-SIGNATURE'] = paymentSignature;
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const metadata = target.op === 'artifact' ? await reportMetadata(fetchImpl, target, controller.signal) : undefined;
      const response = await fetchImpl(target.url, { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: controller.signal });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new RequestError(502, 'upstream_redirect_refused', 'The IMD service redirected this request. Please try again later.');
      if (target.op === 'artifact' && response.status === 200) {
        respondReport(res, await reportBytes(response, target.hash, metadata.bytes), cacheable);
        return;
      }
      const payload = await upstreamBody(response);
      const extra = {};
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && (/^[0-9]{1,8}$/.test(retryAfter) || Number.isFinite(Date.parse(retryAfter)))) extra['Retry-After'] = retryAfter;
      const paymentRequired = response.headers.get('payment-required');
      if (response.status === 402 && paymentRequired && paymentRequired.length <= 32768 && /^[A-Za-z0-9+/=]+$/.test(paymentRequired)) extra['PAYMENT-REQUIRED'] = paymentRequired;
      if (response.status === 200 && cacheable) {
        if (cache.size >= 128) cache.delete(cache.keys().next().value);
        cache.set(target.url, { expires: now() + ttl * 1000, payload });
      }
      const isChallenge = response.status === 402 && record(payload) && payload.x402Version === 2;
      const result = response.status >= 400 && !isChallenge
        ? sanitizeError(payload, [authorization, authorization?.slice(7), paymentSignature, quoteSignature]) : payload;
      respond(res, response.status, result, response.status === 200 && cacheable ? ttl : 0, extra);
    } catch (error) {
      const known = error instanceof RequestError;
      const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      respond(res, known ? error.status : aborted ? 504 : 502, {
        error: known ? error.code : aborted ? 'imd_timeout' : 'imd_unavailable',
        message: known ? error.message : aborted ? 'The IMD service took too long to respond. Please try again.' : 'The IMD service is temporarily unavailable. Please try again.',
      });
    } finally { clearTimeout(timeout); }
  };
}

export default createHandler();
