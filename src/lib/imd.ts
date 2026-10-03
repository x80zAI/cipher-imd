import type { Address } from 'viem';

export const IMD_ADDRESS = '0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7' as const;
export const IMD_NETWORK = 'eip155:1' as const;
export const OFFICIAL_PAY_TO = '0x4e0fA57Bde726079356537E2F34d671E9F41ADbc' as const;

export type PaymentTerms = { network: string; asset: Address; amount: string; payTo: Address; decimals: number; scheme?: 'exact' };
export type PaidQuote = {
  v: 1; id: string; action: string; policyVersion: string; inputHash: string;
  issuedAt: number; expiresAt: number; payment: PaymentTerms & { scheme: 'exact' };
  terms: { purchase: 'action-admission'; resultGuaranteed: false }; quoteHash: string; payer?: Address;
  unitAmount?: string; runs?: number;
};
export type PaymentRequirement = {
  scheme: 'exact'; network: 'eip155:1'; asset: Address; amount: string; payTo: Address;
  maxTimeoutSeconds: number; extra: { assetTransferMethod: 'permit2' };
};
export type PaymentChallenge = {
  x402Version: 2; resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirement[]; quote: PaidQuote; requesterScopeHash: string; resourceUrl: string; input: unknown;
};
export type Capabilities = {
  actions: { action: string; version: string; payment: PaymentTerms; quoteTtlSeconds: number }[];
  limits?: Record<string, unknown>;
  payment: { x402Version: number; scheme: string; assetTransferMethod: string; quoteApproval: string };
};
export type QuotedOrder = { id: string; requestKey: string; status: string; quote: PaidQuote; inputJson: string; createdAt: string; paidAt: string | null };
export type QuoteResponse = { created: boolean; order: QuotedOrder };
export type OrderResponse = {
  status: string; order: QuotedOrder;
  payment?: { status?: string; paid?: boolean; transactionHash?: string } | null;
  admission?: { action: string; result: { kind: string; jobId?: string; statusUrl?: string; resultUrl?: string; [key: string]: unknown } } | null;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;
  constructor(status: number, code: string, payload: unknown) {
    const messages: Record<number, string> = {
      400: 'The service could not accept this request.', 401: 'This order needs its saved access token.',
      402: 'Payment confirmation is required.', 403: 'The service refused access to this request.',
      404: 'This record is not available.', 409: 'The order state changed. Check its status before continuing.',
      410: 'The reviewed quote expired. Request a new quote and review it again.',
      422: 'The service could not accept these request settings.', 429: 'The service is busy. Wait before trying again.',
      503: 'The official service is temporarily unavailable.',
    };
    super(messages[status] ?? 'The service request failed. Check the order before trying again.');
    this.name = 'ApiError'; this.status = status; this.code = code; this.payload = payload;
  }
}

export type ApiParams = Record<string, string | number | boolean | undefined>;
export type ApiPostOptions = { token?: string; id?: string; paymentSignature?: string };
const GET_OPERATIONS = new Set(['capabilities', 'network', 'jobs', 'job', 'panel', 'result', 'submissions', 'order', 'paid-by']);
const POST_OPERATIONS = new Set(['check', 'quote', 'challenge', 'submit']);

function authorization(token?: string): Record<string, string> {
  if (token === undefined) return {};
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('The saved order access token is invalid.');
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(op: string, method: 'GET' | 'POST', params: ApiParams, body: unknown, options: ApiPostOptions): Promise<T> {
  if (!(method === 'GET' ? GET_OPERATIONS : POST_OPERATIONS).has(op)) throw new Error('Unsupported service request.');
  const query = new URLSearchParams({ op });
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const headers: Record<string, string> = { Accept: 'application/json', ...authorization(options.token) };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  if (options.paymentSignature !== undefined) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(options.paymentSignature) || options.paymentSignature.length > 16_384) throw new Error('Invalid payment header.');
    headers['PAYMENT-SIGNATURE'] = options.paymentSignature;
  }
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength > 16_384) throw new Error('The request is too large.');
  let response: Response;
  try {
    response = await fetch(`/api/imd?${query}`, { method, headers, body: encoded, redirect: 'error', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(30_000) });
  } catch { throw new ApiError(0, 'connection_failed', null); }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new ApiError(response.status || 502, 'invalid_response', null); }
  if (!response.ok) {
    const candidate = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>).error : undefined;
    const code = typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(candidate) ? candidate : 'request_failed';
    throw new ApiError(response.status, code, payload);
  }
  return payload as T;
}

export function apiGet<T>(op: string, params: ApiParams = {}, token?: string): Promise<T> { return request(op, 'GET', params, undefined, { token }); }
export function apiPost<T>(op: string, body?: unknown, options: ApiPostOptions = {}): Promise<T> { return request(op, 'POST', options.id ? { id: options.id } : {}, body, options); }
