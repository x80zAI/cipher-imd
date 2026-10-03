export type RequestMode = 'consultation' | 'research';
export type RequestRecord = {
  id: string; requestKey: string; token: string; action: 'job.open'; mode: RequestMode;
  objective: string; createdAt: string; status: string; jobId?: string;
};
export const ORDER_STORAGE_KEY = 'cipher-imd.orders.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class OrderStorageError extends Error {
  constructor(message: string) { super(message); this.name = 'OrderStorageError'; }
}
function validateRecord(value: unknown): RequestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OrderStorageError('The saved order list is damaged. It has not been changed.');
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || !UUID.test(record.id) || typeof record.requestKey !== 'string' || !UUID.test(record.requestKey) ||
      typeof record.token !== 'string' || !/^[0-9a-f]{64}$/.test(record.token) || record.action !== 'job.open' ||
      !['consultation', 'research'].includes(String(record.mode)) || typeof record.objective !== 'string' || record.objective.length < 1 || record.objective.length > 8000 ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) || typeof record.status !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(record.status) ||
      (record.jobId !== undefined && (typeof record.jobId !== 'string' || !UUID.test(record.jobId)))) {
    throw new OrderStorageError('A saved order has invalid fields. The saved list has not been changed.');
  }
  return { id: record.id, requestKey: record.requestKey, token: record.token, action: 'job.open', mode: record.mode as RequestMode,
    objective: record.objective, createdAt: record.createdAt, status: record.status, ...(record.jobId ? { jobId: record.jobId as string } : {}) };
}
function validRecords(records: unknown): RequestRecord[] {
  if (!Array.isArray(records) || records.length > 100) throw new OrderStorageError('The saved order list has an unsupported size.');
  const checked = records.map(validateRecord);
  if (new Set(checked.map(record => record.id)).size !== checked.length) throw new OrderStorageError('The saved order list contains duplicate orders.');
  return checked;
}
export function loadOrders(): RequestRecord[] {
  let raw: string | null;
  try { raw = localStorage.getItem(ORDER_STORAGE_KEY); } catch { throw new OrderStorageError('Browser storage is unavailable. Orders cannot be recovered on this device.'); }
  if (raw === null) return [];
  if (raw.length > 1_000_000) throw new OrderStorageError('The saved order list is too large. It has not been changed.');
  let saved: unknown;
  try { saved = JSON.parse(raw); } catch { throw new OrderStorageError('The saved order list is damaged. It has not been changed.'); }
  if (!saved || typeof saved !== 'object' || (saved as Record<string, unknown>).version !== 1) throw new OrderStorageError('The saved order format is unsupported. It has not been changed.');
  return validRecords((saved as Record<string, unknown>).records);
}
export function saveOrders(records: RequestRecord[]): void {
  const checked = validRecords(records);
  try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify({ version: 1, records: checked })); }
  catch { throw new OrderStorageError('The browser could not save this order. Payment must wait until the order is saved.'); }
}
export function createRequestToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function removeOrder(id: string): RequestRecord[] { const records = loadOrders().filter(record => record.id !== id); saveOrders(records); return records; }
/** Public export deliberately omits the bearer token and request key. */
export function publicOrderExport(records: RequestRecord[]): string {
  return JSON.stringify({ version: 1, orders: validRecords(records).map(record => ({ id: record.id, action: record.action, mode: record.mode, objective: record.objective, createdAt: record.createdAt, status: record.status, ...(record.jobId ? { jobId: record.jobId } : {}) })) }, null, 2);
}
