import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequestToken, loadOrders, ORDER_STORAGE_KEY, publicOrderExport, removeOrder, saveOrders } from '../src/lib/orders';
import type { RequestRecord } from '../src/lib/orders';

const record: RequestRecord = { id: '9d9f9a9e-6d77-42f2-9193-5a74f0b96260', requestKey: '6d345d0a-3899-42b1-9c58-a646f9a48aa8', token: 'c'.repeat(64), action: 'job.open', mode: 'research', objective: 'Explain Ethereum verification using primary sources.', createdAt: '2026-10-04T08:00:00.000Z', status: 'payment_pending' };
let values: Map<string, string>;
beforeEach(() => { values = new Map(); vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }); });
afterEach(() => vi.unstubAllGlobals());
describe('local order recovery and public export', () => {
  it('recovers pending orders and their visitor access tokens while preserving future valid statuses', () => {
    expect(loadOrders()).toEqual([]);
    saveOrders([record]); expect(loadOrders()).toEqual([record]);
    saveOrders([{ ...record, status: 'building' }]); expect(loadOrders()[0].status).toBe('building');
    expect(removeOrder(record.id)).toEqual([]); expect(loadOrders()).toEqual([]);
  });
  it('public export contains no bearer token, request key, signatures or extra unvalidated fields', () => {
    const withExtra = { ...record, paymentSignature: 'secret-signature' };
    saveOrders([withExtra]);
    const exported = publicOrderExport(loadOrders());
    expect(exported).toContain(record.id); expect(exported).not.toContain(record.token); expect(exported).not.toContain(record.requestKey); expect(exported).not.toContain('secret-signature');
    expect(values.get(ORDER_STORAGE_KEY)).not.toContain('secret-signature');
  });
  it('rejects corrupted or incompatible storage without overwriting it', () => {
    for (const damaged of ['{broken', JSON.stringify({ version: 2, records: [record] }), JSON.stringify({ version: 1, records: [{ ...record, token: 'invalid' }] })]) {
      values.set(ORDER_STORAGE_KEY, damaged); expect(() => loadOrders()).toThrow(); expect(values.get(ORDER_STORAGE_KEY)).toBe(damaged);
    }
  });
  it('fails visibly when storage is blocked or full, before a payment can depend on persistence', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error(`Sensitive ${record.token}`); }, setItem: () => { throw new Error(`Sensitive ${record.token}`); } });
    expect(() => loadOrders()).toThrow(/storage is unavailable/);
    expect(() => saveOrders([record])).toThrow(/Payment must wait/);
    try { saveOrders([record]); } catch (error) { expect((error as Error).message).not.toContain(record.token); }
  });
  it('rejects duplicate orders and invalid objectives, then creates 256-bit browser-generated access tokens', () => {
    expect(() => saveOrders([record, record])).toThrow(/duplicate/);
    expect(() => saveOrders([{ ...record, objective: '' }])).toThrow(/invalid fields/);
    const first = createRequestToken(); const second = createRequestToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/); expect(first).not.toBe(second);
  });
});
