import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { ExactEvmScheme, PERMIT2_ADDRESS, permit2WitnessTypes, x402ExactPermit2ProxyAddress } from '@x402/evm';
import type { ClientEvmSigner } from '@x402/evm';
import { encodeFunctionData, getAddress, getTypesForEIP712Domain, parseAbi, serializeTypedData, sha256, stringToBytes } from 'viem';
import type { Address, EIP1193Provider, Hex, TypedDataDefinition } from 'viem';
import { apiGet, apiPost, IMD_ADDRESS, IMD_NETWORK, OFFICIAL_PAY_TO } from './imd';
import type { Capabilities, OrderResponse, PaidQuote, PaymentChallenge } from './imd';

export { PERMIT2_ADDRESS };
export type WalletConnection = { address: Address; provider: EIP1193Provider };
export type WalletState = { balanceIMD: bigint; allowancePermit2: bigint; blockNumber: bigint };
export type PaymentStage = 'verifying' | 'signing-payment' | 'signing-quote' | 'submitting';
export type PayOrderOptions = WalletConnection & {
  token: string; orderId: string; challenge: PaymentChallenge; reviewedQuote: PaidQuote; reviewedInput: unknown;
  onStage?: (stage: PaymentStage) => void;
};
export type PaidSubmission = { result: OrderResponse; retry: () => Promise<OrderResponse> };
export class PaymentSubmissionError extends Error {
  readonly retry: () => Promise<OrderResponse>;
  constructor(retry: () => Promise<OrderResponse>) {
    super('Payment submission could not be confirmed. Check this order or resend the same signed payment; do not create another order.');
    this.name = 'PaymentSubmissionError'; this.retry = retry;
  }
}
class PaymentError extends Error { constructor(message: string) { super(message); this.name = 'PaymentError'; } }
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HASH32 = /^[0-9a-f]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
const QUOTE_APPROVAL_TYPES = { QuoteApproval: [
  { name: 'resource', type: 'string' }, { name: 'requesterScopeHash', type: 'bytes32' },
  { name: 'quoteId', type: 'string' }, { name: 'quoteHash', type: 'bytes32' }, { name: 'paymentHash', type: 'bytes32' },
  { name: 'action', type: 'string' }, { name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' },
  { name: 'payTo', type: 'address' }, { name: 'expiresAt', type: 'uint256' },
] } as const;

function object(value: unknown, message = 'Invalid payment response.'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PaymentError(message);
  return value as Record<string, unknown>;
}
function strictKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new PaymentError('The payment contains unsupported fields.');
}
function sameAddress(value: unknown, expected: string): boolean {
  try { return typeof value === 'string' && getAddress(value) === getAddress(expected); } catch { return false; }
}
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new PaymentError('Invalid exact payment amount.');
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > UINT256_MAX) throw new PaymentError('Invalid exact payment amount.');
  return parsed;
}
function numericHex(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new PaymentError('The wallet returned invalid Ethereum data.');
  return BigInt(value);
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** Canonical JSON used by the official quote-approval protocol. Never round token amounts. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new PaymentError('Unsupported canonical JSON value.');
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new PaymentError('Canonical JSON numbers must be exact integers.');
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new PaymentError('Unsupported canonical JSON value.');
  return JSON.stringify(value);
}
export function canonicalPaymentHash(payment: unknown): Hex { return sha256(stringToBytes(canonicalJson(payment))); }

async function rpc(provider: EIP1193Provider, method: string, params?: readonly unknown[], timeout = 20_000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const invoke = provider.request as unknown as (args: { method: string; params?: readonly unknown[] }) => Promise<unknown>;
    return await Promise.race([invoke.call(provider, { method, ...(params ? { params } : {}) }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PaymentError('The wallet did not respond. Check its activity before retrying.')), timeout); })]);
  } catch (error) {
    if (error instanceof PaymentError) throw error;
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    throw new PaymentError(code === 4001 || code === '4001' ? 'You declined the wallet request.' : 'The wallet request failed. Check your wallet before retrying.');
  } finally { clearTimeout(timer); }
}
async function walletGuard(provider: EIP1193Provider, address: Address): Promise<void> {
  if (numericHex(await rpc(provider, 'eth_chainId')) !== 1n) throw new PaymentError('Switch your wallet to Ethereum mainnet and review the order again.');
  const accounts = await rpc(provider, 'eth_accounts');
  if (!Array.isArray(accounts) || !sameAddress(accounts[0], address)) throw new PaymentError('The active wallet account changed. Reconnect and review the order again.');
}
export async function connectWallet(): Promise<WalletConnection> {
  const injected = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (!injected || typeof injected.request !== 'function') throw new PaymentError('Install or open a browser Ethereum wallet to continue.');
  const accounts = await rpc(injected, 'eth_requestAccounts', undefined, 120_000);
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new PaymentError('The wallet did not share an account.');
  let address: Address;
  try { address = getAddress(accounts[0]); } catch { throw new PaymentError('The wallet shared an invalid account.'); }
  await walletGuard(injected, address);
  return { address, provider: injected };
}
export async function readWallet(address: Address, provider: EIP1193Provider): Promise<WalletState> {
  await walletGuard(provider, address);
  const block = await rpc(provider, 'eth_blockNumber');
  const blockNumber = numericHex(block);
  const contracts = [IMD_ADDRESS, PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress];
  const codes = await Promise.all(contracts.map(to => rpc(provider, 'eth_getCode', [to, block])));
  if (codes.some(code => typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code) || /^0x0*$/.test(code))) throw new PaymentError('The official payment contracts could not be verified on Ethereum.');
  const call = (data: Hex) => rpc(provider, 'eth_call', [{ to: IMD_ADDRESS, data }, block]);
  const [decimals, balance, allowance] = await Promise.all([
    call(encodeFunctionData({ abi: ERC20, functionName: 'decimals' })),
    call(encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [address] })),
    call(encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [address, PERMIT2_ADDRESS] })),
  ]);
  if (numericHex(decimals) !== 18n) throw new PaymentError('The Ethereum token identity check failed.');
  await walletGuard(provider, address);
  return { balanceIMD: numericHex(balance), allowancePermit2: numericHex(allowance), blockNumber };
}

export async function ensureExactAllowance(provider: EIP1193Provider, address: Address, units: bigint): Promise<Hex | null> {
  if (units <= 0n || units > UINT256_MAX) throw new PaymentError('Invalid approval amount.');
  const initial = await readWallet(address, provider);
  if (initial.balanceIMD < units) throw new PaymentError('Your wallet does not hold enough IMD for this order.');
  if (initial.allowancePermit2 >= units) return null;
  const data = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [PERMIT2_ADDRESS, units] });
  await walletGuard(provider, address);
  const hash = await rpc(provider, 'eth_sendTransaction', [{ from: address, to: IMD_ADDRESS, data, value: '0x0', chainId: '0x1' }], 180_000);
  if (typeof hash !== 'string' || !HEX32.test(hash)) throw new PaymentError('The wallet did not return a valid approval hash. Check wallet activity before trying again.');
  const stopAt = Date.now() + 180_000;
  let confirmed = false;
  while (Date.now() < stopAt) {
    await walletGuard(provider, address);
    const receiptValue = await rpc(provider, 'eth_getTransactionReceipt', [hash]);
    if (receiptValue !== null) {
      const receipt = object(receiptValue);
      if (typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new PaymentError('The approval receipt did not match the submitted transaction.');
      if (receipt.status === '0x0') throw new PaymentError('The IMD approval failed on Ethereum. Check wallet activity before continuing.');
      if (receipt.status !== '0x1') throw new PaymentError('The IMD approval receipt could not be verified.');
      confirmed = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!confirmed) throw new PaymentError(`The approval is still unconfirmed. Check this Ethereum transaction before retrying: ${hash}`);
  const transaction = object(await rpc(provider, 'eth_getTransactionByHash', [hash]));
  if (!sameAddress(transaction.from, address) || !sameAddress(transaction.to, IMD_ADDRESS) || transaction.input !== data || numericHex(transaction.value) !== 0n || (transaction.chainId !== undefined && numericHex(transaction.chainId) !== 1n)) {
    throw new PaymentError('The approval transaction differs from the exact approval requested. Check wallet activity before continuing.');
  }
  const after = await readWallet(address, provider);
  if (after.allowancePermit2 !== units) throw new PaymentError('The confirmed Permit2 allowance does not equal the amount approved.');
  return hash as Hex;
}

/** Refuses spoofed payment terms before a wallet signature can be requested. */
export function validatePaymentChallenge(value: unknown, reviewedQuote: PaidQuote, reviewedInput: unknown, orderId: string, address: Address, capabilities: Capabilities, now = Math.floor(Date.now() / 1000)): PaymentChallenge {
  const challenge = object(value);
  if (!UUID.test(orderId) || challenge.x402Version !== 2 || !Array.isArray(challenge.accepts) || challenge.accepts.length !== 1) throw new PaymentError('Invalid official payment challenge.');
  const quote = object(challenge.quote);
  strictKeys(quote, ['v', 'id', 'action', 'policyVersion', 'inputHash', 'issuedAt', 'expiresAt', 'payment', 'terms', 'quoteHash', 'payer', 'unitAmount', 'runs']);
  if (quote.id !== orderId || quote.action !== 'job.open' || canonicalJson(quote) !== canonicalJson(reviewedQuote) || canonicalJson(challenge.input) !== canonicalJson(reviewedInput)) throw new PaymentError('The payment challenge differs from the order you reviewed.');
  if (quote.v !== 1 || !integer(quote.issuedAt) || !integer(quote.expiresAt) || quote.issuedAt > now + 30 || quote.expiresAt <= now + 30 || quote.expiresAt <= quote.issuedAt || typeof quote.quoteHash !== 'string' || !HASH32.test(quote.quoteHash) || typeof quote.inputHash !== 'string' || !HASH32.test(quote.inputHash) || typeof challenge.requesterScopeHash !== 'string' || !HASH32.test(challenge.requesterScopeHash)) throw new PaymentError('The reviewed quote is invalid or too close to expiry.');
  if (quote.payer !== undefined && !sameAddress(quote.payer, address)) throw new PaymentError('This quote belongs to a different paying wallet.');
  const terms = object(quote.terms);
  strictKeys(terms, ['purchase', 'resultGuaranteed']);
  if (terms.purchase !== 'action-admission' || terms.resultGuaranteed !== false) throw new PaymentError('The official purchase terms could not be verified.');
  const payment = object(quote.payment);
  strictKeys(payment, ['network', 'asset', 'amount', 'payTo', 'decimals', 'scheme']);
  const requirement = object(challenge.accepts[0]);
  strictKeys(requirement, ['scheme', 'network', 'asset', 'amount', 'payTo', 'maxTimeoutSeconds', 'extra']);
  const extra = object(requirement.extra);
  strictKeys(extra, ['assetTransferMethod']);
  const cap = capabilities.actions?.find(item => item.action === quote.action);
  if (!cap || capabilities.payment?.x402Version !== 2 || capabilities.payment.scheme !== 'exact' || capabilities.payment.assetTransferMethod !== 'permit2' || capabilities.payment.quoteApproval !== 'EIP-712') throw new PaymentError('The official service does not currently offer this payment method.');
  if (!integer(cap.quoteTtlSeconds) || quote.expiresAt - quote.issuedAt > cap.quoteTtlSeconds) throw new PaymentError('The quote lifetime differs from the official service.');
  for (const row of [payment, requirement, cap.payment]) {
    if (row.network !== IMD_NETWORK || !sameAddress(row.asset, IMD_ADDRESS) || !sameAddress(row.payTo, OFFICIAL_PAY_TO) || amount(row.amount) !== amount(payment.amount)) throw new PaymentError('The token, network, recipient or amount differs from the official IMD payment.');
  }
  if (payment.decimals !== 18 || cap.payment.decimals !== 18 || payment.scheme !== 'exact' || requirement.scheme !== 'exact' || extra.assetTransferMethod !== 'permit2' || !integer(requirement.maxTimeoutSeconds) || requirement.maxTimeoutSeconds < 1 || requirement.maxTimeoutSeconds > cap.quoteTtlSeconds) throw new PaymentError('Invalid exact Permit2 payment terms.');
  const orderUrl = `https://api.imd.fun/requests/${orderId}`;
  // The live service identifies the order itself as its payment resource.
  // Older documentation uses /submit; both are bound to this exact order.
  const allowedResources = [orderUrl, `${orderUrl}/submit`];
  const resource = object(challenge.resource);
  strictKeys(resource, ['url', 'description', 'mimeType']);
  if (typeof challenge.resourceUrl !== 'string' || !allowedResources.includes(challenge.resourceUrl) || resource.url !== challenge.resourceUrl || (resource.description !== undefined && typeof resource.description !== 'string') || (resource.mimeType !== undefined && typeof resource.mimeType !== 'string')) throw new PaymentError('The payment resource is not this official IMD order.');
  return structuredClone(value) as PaymentChallenge;
}

function validatePermitMessage(data: Parameters<ClientEvmSigner['signTypedData']>[0], challenge: PaymentChallenge): void {
  const domain = data.domain;
  const message = data.message;
  const permitted = object(message.permitted);
  const witness = object(message.witness);
  if (data.primaryType !== 'PermitWitnessTransferFrom' || domain.name !== 'Permit2' || domain.chainId !== 1 || !sameAddress(domain.verifyingContract, PERMIT2_ADDRESS) ||
      canonicalJson(data.types) !== canonicalJson(permit2WitnessTypes) || !sameAddress(permitted.token, IMD_ADDRESS) || permitted.amount !== BigInt(challenge.quote.payment.amount) ||
      !sameAddress(message.spender, x402ExactPermit2ProxyAddress) || !sameAddress(witness.to, challenge.quote.payment.payTo) || witness.validAfter !== 0n ||
      typeof message.nonce !== 'bigint' || message.nonce < 0n || message.nonce > UINT256_MAX || typeof message.deadline !== 'bigint' || message.deadline <= BigInt(Math.floor(Date.now() / 1000) + 6) || message.deadline >= BigInt(challenge.quote.expiresAt)) {
    throw new PaymentError('The wallet payment authorization differs from the reviewed exact IMD payment.');
  }
  strictKeys(domain, ['name', 'chainId', 'verifyingContract']);
  strictKeys(message, ['permitted', 'spender', 'nonce', 'deadline', 'witness']);
  strictKeys(permitted, ['token', 'amount']); strictKeys(witness, ['to', 'validAfter']);
}
async function sign(provider: EIP1193Provider, address: Address, data: Parameters<ClientEvmSigner['signTypedData']>[0]): Promise<Hex> {
  await walletGuard(provider, address);
  const definition = { ...data, types: { EIP712Domain: getTypesForEIP712Domain({ domain: data.domain }), ...data.types } };
  const encoded = serializeTypedData(definition as unknown as TypedDataDefinition);
  const signature = await rpc(provider, 'eth_signTypedData_v4', [address, encoded], 180_000);
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new PaymentError('The wallet did not return the required 65-byte signature.');
  await walletGuard(provider, address);
  return signature as Hex;
}

export async function payOrder(options: PayOrderOptions): Promise<PaidSubmission> {
  const { provider, address, token, orderId, onStage } = options;
  if (!/^[0-9a-f]{64}$/.test(token)) throw new PaymentError('The order access token is invalid.');
  // Freeze the exact visitor-reviewed input and quote before any asynchronous work.
  const reviewedQuote = structuredClone(options.reviewedQuote);
  const reviewedInput = structuredClone(options.reviewedInput);
  const initialChallenge = structuredClone(options.challenge);
  onStage?.('verifying');
  const capabilities = await apiGet<Capabilities>('capabilities');
  const challenge = validatePaymentChallenge(initialChallenge, reviewedQuote, reviewedInput, orderId, address, capabilities);
  const state = await readWallet(address, provider);
  const units = BigInt(challenge.quote.payment.amount);
  if (state.balanceIMD < units) throw new PaymentError('Your wallet does not hold enough IMD for this reviewed order.');
  if (state.allowancePermit2 < units) throw new PaymentError('Approve the exact IMD amount for Permit2 before signing this payment.');
  const requirement = challenge.accepts[0];
  let signatureCalls = 0;
  const signer: ClientEvmSigner = { address, signTypedData: async data => {
    if (++signatureCalls !== 1) throw new PaymentError('Unexpected additional wallet signature request.');
    validatePaymentChallenge(challenge, reviewedQuote, reviewedInput, orderId, address, capabilities);
    validatePermitMessage(data, challenge);
    onStage?.('signing-payment');
    return sign(provider, address, data);
  } };
  // A shorter signature window is valid under the original requirement. Keep
  // accepted identical to the challenge, and constrain only the SDK's deadline.
  const signingTimeout = Math.min(requirement.maxTimeoutSeconds, challenge.quote.expiresAt - Math.floor(Date.now() / 1000) - 2);
  if (signingTimeout < 15) throw new PaymentError('The quote is too close to expiry. Review a fresh quote before paying.');
  const client = x402Client.fromConfig({
    schemes: [{ network: IMD_NETWORK, client: new ExactEvmScheme(signer) }],
    spendControls: { allowedAssets: [{ network: IMD_NETWORK, asset: IMD_ADDRESS, maxAmountPerPayment: requirement.amount }] },
  });
  const generated = await client.createPaymentPayload({ x402Version: 2, resource: challenge.resource, accepts: [{ ...requirement, maxTimeoutSeconds: signingTimeout }] });
  const payload = object(generated.payload);
  strictKeys(payload, ['signature', 'permit2Authorization']);
  const permit = object(payload.permit2Authorization);
  strictKeys(permit, ['from', 'permitted', 'spender', 'nonce', 'deadline', 'witness']);
  const permitted = object(permit.permitted); const witness = object(permit.witness);
  strictKeys(permitted, ['token', 'amount']); strictKeys(witness, ['to', 'validAfter']);
  if (!sameAddress(permit.from, address) || !sameAddress(permitted.token, IMD_ADDRESS) || permitted.amount !== requirement.amount || !sameAddress(permit.spender, x402ExactPermit2ProxyAddress) || !sameAddress(witness.to, requirement.payTo) || witness.validAfter !== '0' || amount(permit.deadline) >= BigInt(challenge.quote.expiresAt) || amount(permit.deadline) <= BigInt(Math.floor(Date.now() / 1000) + 6)) throw new PaymentError('The signed payment payload does not match the reviewed order.');
  const payment: PaymentPayload = JSON.parse(JSON.stringify({ x402Version: 2, resource: challenge.resource, accepted: requirement, payload: generated.payload }));
  const paymentSignature = encodePaymentSignatureHeader(payment);
  validatePaymentChallenge(challenge, reviewedQuote, reviewedInput, orderId, address, capabilities);
  onStage?.('signing-quote');
  const quote = challenge.quote;
  const quoteSignature = await sign(provider, address, {
    domain: { name: 'IdentityMD Paid Action', version: '1', chainId: 1 }, primaryType: 'QuoteApproval', types: QUOTE_APPROVAL_TYPES,
    message: { resource: challenge.resourceUrl, requesterScopeHash: `0x${challenge.requesterScopeHash}`, quoteId: quote.id, quoteHash: `0x${quote.quoteHash}`,
      paymentHash: canonicalPaymentHash(payment), action: quote.action, asset: quote.payment.asset, amount: BigInt(quote.payment.amount), payTo: quote.payment.payTo, expiresAt: BigInt(quote.expiresAt) },
  });
  await walletGuard(provider, address);
  // These two signed strings remain only in this closure. A retry sends precisely
  // the same order, header and body; it never creates a quote or signs again.
  const retry = async (): Promise<OrderResponse> => {
    onStage?.('submitting');
    return apiPost<OrderResponse>('submit', { quoteSignature }, { token, id: orderId, paymentSignature });
  };
  try { return { result: await retry(), retry }; } catch { throw new PaymentSubmissionError(retry); }
}
