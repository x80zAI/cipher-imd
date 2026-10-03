import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { decodeFunctionData, parseAbi, toHex } from 'viem';
import type { Address, EIP1193Provider } from 'viem';
import { apiPost, ApiError, IMD_ADDRESS, OFFICIAL_PAY_TO } from '../src/lib/imd';
import type { Capabilities, PaidQuote, PaymentChallenge } from '../src/lib/imd';
import { canonicalJson, canonicalPaymentHash, ensureExactAllowance, payOrder, PaymentSubmissionError, PERMIT2_ADDRESS, validatePaymentChallenge } from '../src/lib/payment';

const NOW = 1_791_100_000;
const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;
const ORDER_ID = '9d9f9a9e-6d77-42f2-9193-5a74f0b96260';
const TOKEN = 'c'.repeat(64);
const UNITS = 500_000_000_000_000_000n;
const SIG = `0x${'ab'.repeat(65)}`;
const TX_HASH = `0x${'ee'.repeat(32)}`;
const input = { template: 'research', objective: 'Compare EVM verification approaches with primary sources.', panelSize: 3, panelQuorum: 2, minCitations: 5, github: false };
function fixture(): { challenge: PaymentChallenge; quote: PaidQuote; capabilities: Capabilities } {
  const payment = { network: 'eip155:1', asset: IMD_ADDRESS, amount: UNITS.toString(), payTo: OFFICIAL_PAY_TO, decimals: 18, scheme: 'exact' as const };
  const quote: PaidQuote = { v: 1, id: ORDER_ID, action: 'job.open', policyVersion: 'job-1', inputHash: 'a'.repeat(64), issuedAt: NOW, expiresAt: NOW + 600, payment,
    terms: { purchase: 'action-admission', resultGuaranteed: false }, quoteHash: 'b'.repeat(64) };
  const resourceUrl = `https://api.imd.fun/requests/${ORDER_ID}`;
  const challenge: PaymentChallenge = { x402Version: 2, resource: { url: resourceUrl, description: 'One job.open request', mimeType: 'application/json' }, resourceUrl,
    accepts: [{ scheme: 'exact', network: 'eip155:1', asset: IMD_ADDRESS, amount: UNITS.toString(), payTo: OFFICIAL_PAY_TO, maxTimeoutSeconds: 600, extra: { assetTransferMethod: 'permit2' } }], quote, requesterScopeHash: 'd'.repeat(64), input: structuredClone(input) };
  const capabilities: Capabilities = { actions: [{ action: 'job.open', version: 'job-1', payment, quoteTtlSeconds: 600 }], payment: { x402Version: 2, scheme: 'exact', assetTransferMethod: 'permit2', quoteApproval: 'EIP-712' } };
  return { challenge, quote: structuredClone(quote), capabilities };
}
type SignedData = { domain: Record<string, unknown>; primaryType: string; types: Record<string, unknown>; message: Record<string, unknown> };
function wallet(options: { allowance?: bigint; balance?: bigint; chain?: string; changeAfterFirstSignature?: boolean; revertApproval?: boolean } = {}) {
  let allowance = options.allowance ?? UNITS;
  let active = ADDRESS;
  let transaction: Record<string, unknown> | undefined;
  const signed: SignedData[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    if (method === 'eth_chainId') return options.chain ?? '0x1';
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [active];
    if (method === 'eth_blockNumber') return '0x123456';
    if (method === 'eth_getCode') return '0x60016000';
    if (method === 'eth_call') {
      const data = (params?.[0] as { data: string }).data;
      if (data.startsWith('0x313ce567')) return toHex(18n, { size: 32 });
      if (data.startsWith('0x70a08231')) return toHex(options.balance ?? UNITS * 2n, { size: 32 });
      if (data.startsWith('0xdd62ed3e')) return toHex(allowance, { size: 32 });
    }
    if (method === 'eth_signTypedData_v4') {
      signed.push(JSON.parse(params?.[1] as string));
      if (options.changeAfterFirstSignature) active = OTHER;
      return SIG;
    }
    if (method === 'eth_sendTransaction') {
      transaction = params?.[0] as Record<string, unknown>;
      const decoded = decodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), data: transaction.data as `0x${string}` });
      allowance = decoded.args[1];
      return TX_HASH;
    }
    if (method === 'eth_getTransactionReceipt') return { transactionHash: TX_HASH, status: options.revertApproval ? '0x0' : '0x1' };
    if (method === 'eth_getTransactionByHash') return { ...transaction, input: transaction?.data };
    throw new Error(`Unexpected test wallet method: ${method}`);
  });
  return { provider: { request } as unknown as EIP1193Provider, request, signed };
}
function service(capabilities: Capabilities, submit: (init: RequestInit) => Response | Promise<Response> = () => Response.json({ status: 'payment_pending' }, { status: 202 })) {
  return vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    if (url === '/api/imd?op=capabilities') return Response.json(capabilities);
    if (url === `/api/imd?op=submit&id=${ORDER_ID}`) return submit(init);
    throw new Error(`Unexpected test API request: ${url}`);
  });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('official IMD challenge checks', () => {
  it('accepts the live order resource without /submit, preserves it, and scopes documented alternatives to the same order', () => {
    const data = fixture();
    const expectedResource = `https://api.imd.fun/requests/${ORDER_ID}`;
    expect(validatePaymentChallenge(data.challenge, data.quote, input, ORDER_ID, ADDRESS, data.capabilities).resourceUrl).toBe(expectedResource);
    const documented = structuredClone(data.challenge);
    documented.resourceUrl = `${expectedResource}/submit`; documented.resource.url = documented.resourceUrl;
    expect(validatePaymentChallenge(documented, data.quote, input, ORDER_ID, ADDRESS, data.capabilities).resourceUrl).toBe(documented.resourceUrl);
    for (const url of [`${expectedResource}/submit?redirect=1`, 'https://api.imd.fun/requests/6d345d0a-3899-42b1-9c58-a646f9a48aa8', `${expectedResource}/`, `https://api.imd.fun.evil.example/requests/${ORDER_ID}`]) {
      const changed = structuredClone(data.challenge); changed.resourceUrl = url; changed.resource.url = url;
      expect(() => validatePaymentChallenge(changed, data.quote, input, ORDER_ID, ADDRESS, data.capabilities)).toThrow(/resource/);
    }
    const mismatch = structuredClone(data.challenge); mismatch.resource.url = documented.resourceUrl;
    expect(() => validatePaymentChallenge(mismatch, data.quote, input, ORDER_ID, ADDRESS, data.capabilities)).toThrow(/resource/);
  });
  it('accepts the exact reviewed terms but refuses another recipient, network, token, payer or amount', () => {
    const good = fixture();
    expect(validatePaymentChallenge(good.challenge, good.quote, input, ORDER_ID, ADDRESS, good.capabilities)).toEqual(good.challenge);
    const attempts: ((challenge: PaymentChallenge) => void)[] = [
      challenge => { challenge.accepts[0].payTo = OTHER; },
      challenge => { challenge.quote.payment.asset = OTHER; },
      challenge => { challenge.accepts[0].network = 'eip155:8453' as 'eip155:1'; },
      challenge => { challenge.accepts[0].amount = (UNITS + 1n).toString(); },
      challenge => { challenge.quote.payer = OTHER; },
    ];
    for (const mutate of attempts) {
      const changed = structuredClone(good.challenge); mutate(changed);
      expect(() => validatePaymentChallenge(changed, good.quote, input, ORDER_ID, ADDRESS, good.capabilities)).toThrow();
    }
  });
  it('refuses even a matching forged quote if live official capabilities or the pinned receiver differ', () => {
    const data = fixture(); data.quote.payment.payTo = OTHER; data.challenge.quote.payment.payTo = OTHER; data.challenge.accepts[0].payTo = OTHER; data.capabilities.actions[0].payment.payTo = OTHER;
    expect(() => validatePaymentChallenge(data.challenge, data.quote, input, ORDER_ID, ADDRESS, data.capabilities)).toThrow(/recipient/);
  });
  it('binds the reviewed input, order resource and exact requirement shape', () => {
    const data = fixture();
    for (const changed of [
      { ...data.challenge, input: { ...input, objective: 'Changed objective' } },
      { ...data.challenge, resourceUrl: 'https://attacker.example/submit' },
      { ...data.challenge, accepts: [{ ...data.challenge.accepts[0], extra: { assetTransferMethod: 'permit2', spender: OTHER } }] },
    ]) expect(() => validatePaymentChallenge(changed, data.quote, input, ORDER_ID, ADDRESS, data.capabilities)).toThrow();
  });
  it('refuses expired quotes and precision-unsafe token amounts', () => {
    const data = fixture(); data.quote.expiresAt = NOW + 29; data.challenge.quote.expiresAt = NOW + 29;
    expect(() => validatePaymentChallenge(data.challenge, data.quote, input, ORDER_ID, ADDRESS, data.capabilities)).toThrow(/expiry/);
    const invalid = fixture(); invalid.challenge.accepts[0].amount = '0.5';
    expect(() => validatePaymentChallenge(invalid.challenge, invalid.quote, input, ORDER_ID, ADDRESS, invalid.capabilities)).toThrow();
  });
});

describe('canonical payment hashing', () => {
  it('sorts nested keys, preserves uint256 strings and produces the exact SHA256', () => {
    const payment = { z: { b: '900719925474099312345678901234567890', a: ['IMD', 1, null] }, a: true };
    const expected = '{"a":true,"z":{"a":["IMD",1,null],"b":"900719925474099312345678901234567890"}}';
    expect(canonicalJson(payment)).toBe(expected);
    expect(canonicalPaymentHash(payment)).toBe(`0x${createHash('sha256').update(expected).digest('hex')}`);
    for (const value of [undefined, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, { undefined }, new Date()]) expect(() => canonicalJson(value)).toThrow();
  });
});

describe('wallet payment flow without live transactions', () => {
  it('uses both official EIP712 signatures, limits the deadline and hashes the exact header payload', async () => {
    const data = fixture(); const visitor = wallet();
    let posted: RequestInit | undefined;
    const fetch = service(data.capabilities, init => { posted = init; return Response.json({ status: 'payment_pending' }, { status: 202 }); });
    vi.stubGlobal('fetch', fetch);
    await payOrder({ provider: visitor.provider, address: ADDRESS, token: TOKEN, orderId: ORDER_ID, challenge: data.challenge, reviewedQuote: data.quote, reviewedInput: input });
    expect(visitor.signed.map(value => value.primaryType)).toEqual(['PermitWitnessTransferFrom', 'QuoteApproval']);
    expect(visitor.signed[0].domain).toMatchObject({ name: 'Permit2', chainId: 1, verifyingContract: PERMIT2_ADDRESS.toLowerCase() });
    expect(BigInt(visitor.signed[0].message.deadline as string)).toBeLessThan(BigInt(data.quote.expiresAt));
    const header = (posted?.headers as Record<string, string>)['PAYMENT-SIGNATURE'];
    const payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(payment).not.toHaveProperty('extensions');
    expect(payment.accepted).toEqual(data.challenge.accepts[0]);
    expect(payment.resource.url).toBe(`https://api.imd.fun/requests/${ORDER_ID}`);
    expect(visitor.signed[1].message.resource).toBe(payment.resource.url);
    expect(visitor.signed[1].message.paymentHash).toBe(canonicalPaymentHash(payment));
    expect(visitor.signed[1].message.amount).toBe(UNITS.toString());
    expect(visitor.request.mock.calls.some(([arg]) => arg.method === 'eth_sendTransaction')).toBe(false);
  });
  it('stops before signatures on the wrong chain, insufficient allowance, or a wallet account change', async () => {
    const data = fixture(); vi.stubGlobal('fetch', service(data.capabilities));
    for (const options of [{ chain: '0x2105' }, { allowance: 0n }, { balance: 0n }]) {
      const visitor = wallet(options);
      await expect(payOrder({ provider: visitor.provider, address: ADDRESS, token: TOKEN, orderId: ORDER_ID, challenge: data.challenge, reviewedQuote: data.quote, reviewedInput: input })).rejects.toThrow();
      expect(visitor.signed).toHaveLength(0);
    }
    const changed = wallet({ changeAfterFirstSignature: true });
    await expect(payOrder({ provider: changed.provider, address: ADDRESS, token: TOKEN, orderId: ORDER_ID, challenge: data.challenge, reviewedQuote: data.quote, reviewedInput: input })).rejects.toThrow(/account changed/);
    expect(changed.signed).toHaveLength(1);
  });
  it('retains only an in-memory retry that resends identical bytes without another quote or signature', async () => {
    const data = fixture(); const visitor = wallet(); const sent: RequestInit[] = [];
    vi.stubGlobal('fetch', service(data.capabilities, init => { sent.push(init); if (sent.length === 1) throw new Error('Lost response'); return Response.json({ status: 'payment_pending' }, { status: 202 }); }));
    let failure: PaymentSubmissionError | undefined;
    try { await payOrder({ provider: visitor.provider, address: ADDRESS, token: TOKEN, orderId: ORDER_ID, challenge: data.challenge, reviewedQuote: data.quote, reviewedInput: input }); }
    catch (error) { expect(error).toBeInstanceOf(PaymentSubmissionError); failure = error as PaymentSubmissionError; }
    expect(failure).toBeDefined();
    await failure?.retry();
    expect(sent).toHaveLength(2); expect(sent[0].body).toBe(sent[1].body); expect(sent[0].headers).toEqual(sent[1].headers); expect(visitor.signed).toHaveLength(2);
    expect(failure?.message).not.toContain(TOKEN); expect(failure?.message).not.toContain(SIG);
  });
  it('asks for only the exact Permit2 allowance and requires a successful receipt', async () => {
    const visitor = wallet({ allowance: 0n });
    await expect(ensureExactAllowance(visitor.provider, ADDRESS, UNITS)).resolves.toBe(TX_HASH);
    const sent = visitor.request.mock.calls.find(([arg]) => arg.method === 'eth_sendTransaction')?.[0].params?.[0] as { to: string; data: `0x${string}` };
    expect(sent.to).toBe(IMD_ADDRESS);
    const decoded = decodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), data: sent.data });
    expect(decoded.args).toEqual([PERMIT2_ADDRESS, UNITS]);
    const reverted = wallet({ allowance: 0n, revertApproval: true });
    await expect(ensureExactAllowance(reverted.provider, ADDRESS, UNITS)).rejects.toThrow(/failed on Ethereum/);
  });
  it('exposes a 402 challenge payload without leaking upstream error text into its message', async () => {
    const data = fixture(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(data.challenge, { status: 402 })));
    try { await apiPost('challenge', undefined, { token: TOKEN, id: ORDER_ID }); }
    catch (error) { expect(error).toBeInstanceOf(ApiError); expect((error as ApiError).status).toBe(402); expect((error as ApiError).payload).toEqual(data.challenge); expect((error as Error).message).not.toContain(TOKEN); }
  });
});
