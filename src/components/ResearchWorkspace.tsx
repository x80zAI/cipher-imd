import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, DownloadSimple, Key, Spinner, Wallet } from '@phosphor-icons/react';
import { formatUnits, type Address, type EIP1193Provider } from 'viem';
import { ApiError, apiGet, apiPost, IMD_ADDRESS, OFFICIAL_PAY_TO, type Capabilities, type PaidQuote, type PaymentChallenge } from '../lib/imd';
import { connectWallet, ensureExactAllowance, payOrder, PaymentSubmissionError, readWallet, validatePaymentChallenge, type PaymentStage } from '../lib/payment';
import { createRequestToken, loadOrders, publicOrderExport, removeOrder, saveOrders, type RequestRecord } from '../lib/orders';

type JsonObject = Record<string, unknown>;
type Mode = 'consultation' | 'report';
type Review = { record: RequestRecord; quote: PaidQuote; challenge: PaymentChallenge; input: JsonObject };
// Pending signed submissions survive navigation, but never a page reload or export.
const pendingPayments = new Map<string, () => Promise<unknown>>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
function text(value: unknown, fallback = '') { return typeof value === 'string' ? value : fallback; }
function message(error: unknown) { return error instanceof Error ? error.message : 'The request could not be completed. Please try again.'; }
function safeLink(value: unknown) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function download(name: string, value: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function storeRecord(record: RequestRecord) {
  const records = loadOrders();
  if (records.length >= 100 && !records.some(item => item.id === record.id)) throw new Error('This browser has reached 100 saved orders. Export your references and remove a finished order in My requests before creating another.');
  const next = [record, ...records.filter(item => item.id !== record.id)];
  saveOrders(next);
  window.dispatchEvent(new Event('cipher-orders-changed'));
}
function readableQuote(value: unknown): PaidQuote {
  const quote = object(value); const payment = object(quote.payment);
  if (typeof payment.amount !== 'string' || !/^\d{1,78}$/.test(payment.amount) || BigInt(payment.amount) <= 0n || payment.decimals !== 18 || payment.network !== 'eip155:1' || text(payment.asset).toLowerCase() !== IMD_ADDRESS.toLowerCase() || text(payment.payTo).toLowerCase() !== OFFICIAL_PAY_TO.toLowerCase() || typeof quote.expiresAt !== 'number' || !Number.isSafeInteger(quote.expiresAt) || typeof quote.id !== 'string' || !uuidPattern.test(quote.id)) {
    throw new Error('The service returned an unexpected quote. Nothing was authorized.');
  }
  return quote as unknown as PaidQuote;
}

export function ResearchWorkspace({ initialMode = 'consultation' }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [objective, setObjective] = useState('');
  const [panelSize, setPanelSize] = useState(3);
  const [quorum, setQuorum] = useState(2);
  const [citations, setCitations] = useState(3);
  const [review, setReview] = useState<Review | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [wallet, setWallet] = useState<{ address: Address; provider: EIP1193Provider } | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [retry, setRetry] = useState<(() => Promise<unknown>) | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    apiGet<Capabilities>('capabilities').then(value => { if (mounted.current) setCapabilities(value); }).catch(() => {});
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { if (!review) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [review]);
  const jobAction = capabilities?.actions.find(item => item.action === 'job.open');
  const liveFee = jobAction ? `${formatUnits(BigInt(jobAction.payment.amount), jobAction.payment.decimals)} IMD` : 'Read at review';
  const awaitingConfirmation = Boolean(retry && review && !review.record.jobId && !['admitted', 'expired', 'payment_failed'].includes(review.record.status));
  function changed() { setReview(null); setConsent(false); setRetry(null); setError(''); setNotice(''); }
  function makeInput(): JsonObject {
    const objectiveValue = objective.trim();
    if (!objectiveValue) throw new Error('Write the question or research objective you want the agents to investigate.');
    if (mode === 'consultation') {
      if (objectiveValue.length > 4000) throw new Error('Keep a consultation within 4,000 characters.');
      return { objective: objectiveValue, template: 'research', panelSize, panelQuorum: Math.min(quorum, panelSize), minCitations: citations, github: false };
    }
    return { objective: objectiveValue, skill: 'research-report', outputs: [{ name: 'report', path: 'artifacts/report.md', mediaType: 'text/markdown' }], minCitations: citations, github: false };
  }
  async function prepare(event: React.FormEvent) {
    event.preventDefault(); if (busy || awaitingConfirmation) return;
    setBusy(true); setError(''); setNotice(''); setReview(null); setConsent(false); setRetry(null);
    try {
      const input = makeInput(); setStage('Checking your request with IMD…');
      if (loadOrders().length >= 100) throw new Error('This browser has reached 100 saved orders. Export your references and remove a finished order in My requests before creating another.');
      const checked = await apiPost<JsonObject>('check', { action: 'job.open', input });
      const blockers = Array.isArray(checked.blockers) ? checked.blockers : [];
      if (blockers.length) throw new Error(blockers.map(item => typeof item === 'string' ? item : text(object(item).message, text(object(item).detail, text(object(item).code, 'The request needs more detail.')))).join(' '));
      setStage('Preparing a live quote…');
      const token = createRequestToken(); const requestKey = crypto.randomUUID();
      const quoted = await apiPost<JsonObject>('quote', { requestKey, action: 'job.open', input }, { token });
      const order = object(quoted.order); const quote = readableQuote(order.quote);
      const id = text(order.id); if (!uuidPattern.test(id)) throw new Error('IMD returned an invalid order. Nothing was paid.');
      const record: RequestRecord = { id, requestKey, token, action: 'job.open', mode: mode === 'report' ? 'research' : 'consultation', objective: objective.trim(), createdAt: new Date().toISOString(), status: 'quoted' };
      storeRecord(record);
      let challenge: PaymentChallenge;
      try { challenge = await apiPost<PaymentChallenge>('challenge', undefined, { token, id }); }
      catch (err) { if (err instanceof ApiError && err.status === 402 && object(err.payload).x402Version === 2) challenge = err.payload as PaymentChallenge; else throw err; }
      const prepared = object(challenge.input);
      setReview({ record, quote, challenge, input: Object.keys(prepared).length ? prepared : input });
      setClock(Date.now());
      setStage('Quote ready. No payment has been made.');
    } catch (err) { setError(message(err)); setStage(''); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function connect() {
    setBusy(true); setError('');
    try { const connected = await connectWallet(); const account = await readWallet(connected.address, connected.provider); setWallet(connected); setBalance(account.balanceIMD); }
    catch (err) { setError(message(err)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function pay() {
    if (!review || !consent || busy) return;
    setBusy(true); setError(''); setRetry(null);
    try {
      const connected = wallet ?? await connectWallet(); setWallet(connected);
      const account = await readWallet(connected.address, connected.provider); setBalance(account.balanceIMD);
      const currentCapabilities = await apiGet<Capabilities>('capabilities');
      validatePaymentChallenge(review.challenge, review.quote, review.input, review.record.id, connected.address, currentCapabilities);
      const amount = BigInt(review.quote.payment.amount);
      if (account.balanceIMD < amount) throw new Error('Your wallet does not have enough IMD for this request.');
      setStage('Checking your wallet’s IMD payment permission…');
      if (account.allowancePermit2 < amount) {
        setStage('Confirm the exact IMD spending permission in your wallet. This approval needs ETH for the Ethereum network fee.');
        await ensureExactAllowance(connected.provider, connected.address, amount);
      }
      const progress: Record<PaymentStage, string> = { verifying: 'Verifying the live payment terms…', 'signing-payment': 'Confirm the exact IMD payment in your wallet (signature 1 of 2).', 'signing-quote': 'Confirm that this payment is for the request you reviewed (signature 2 of 2).', submitting: 'Sending your authorized request to IMD…' };
      const paid = await payOrder({ ...connected, token: review.record.token, orderId: review.record.id, challenge: review.challenge, reviewedQuote: review.quote, reviewedInput: review.input, onStage: value => setStage(progress[value]) });
      setRetry(() => paid.retry);
      pendingPayments.set(review.record.id, paid.retry);
      const response = object(paid.result); const admission = object(response.admission); const result = object(admission.result);
      const next: RequestRecord = { ...review.record, status: text(response.status, 'payment_pending'), ...(uuidPattern.test(text(result.jobId)) ? { jobId: text(result.jobId) } : {}) };
      try { storeRecord(next); } catch { setNotice('Your order is available below, but this browser could not save it. Copy the order ID before closing the page.'); }
      setReview({ ...review, record: next });
      if (next.jobId || ['admitted', 'expired', 'payment_failed'].includes(next.status)) { pendingPayments.delete(next.id); setRetry(null); }
      setStage(next.jobId ? 'Your request has been admitted. Follow its work in My requests.' : 'Payment submitted. Check the order status before taking any further action.');
    } catch (err) {
      if (err instanceof PaymentSubmissionError) {
        setRetry(() => err.retry);
        pendingPayments.set(review.record.id, err.retry);
        const pending = { ...review.record, status: 'payment_pending' };
        setReview({ ...review, record: pending });
        try { storeRecord(pending); } catch { setNotice('Keep this page open to retain access to the original signed payment.'); }
      }
      setError(`${message(err)} If you confirmed a payment signature, check this order in My requests before trying again.`);
    }
    finally { if (mounted.current) setBusy(false); }
  }
  async function retryPayment() {
    if (!retry || busy) return; setBusy(true); setError('');
    try { await retry(); setStage('The original payment was sent again. Check its status in My requests.'); }
    catch (err) { setError(message(err)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function checkOrder() {
    if (!review || busy) return; setBusy(true); setError('');
    try {
      const value = await apiGet<JsonObject>('order', { id: review.record.id }, review.record.token);
      const result = object(object(value.admission).result);
      const next = { ...review.record, status: text(value.status, review.record.status), ...(uuidPattern.test(text(result.jobId)) ? { jobId: text(result.jobId) } : {}) };
      storeRecord(next); setReview({ ...review, record: next });
      if (next.jobId || ['admitted', 'expired', 'payment_failed'].includes(next.status)) { setRetry(null); pendingPayments.delete(next.id); }
      setStage(next.jobId ? 'Your request has been admitted. Its work is available in My requests.' : `Current order status: ${next.status}.`);
    } catch (err) { setError(message(err)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const paidOrPending = review && review.record.status !== 'quoted';
  const quoteExpired = review ? clock >= Number(review.quote.expiresAt) * 1000 : false;
  return <div className="research-shell">
    <div className="workspace-intro"><span className="eyebrow">CREATE / A REAL REQUEST</span><h2>Ask better. Find more.</h2><p>Give the IMD agents a clear question. Review the actual price and request before your wallet authorizes anything.</p></div>
    <div className="mode-switch" role="group" aria-label="Request type"><button type="button" className={mode === 'consultation' ? 'selected' : ''} disabled={busy || awaitingConfirmation} onClick={() => { changed(); setMode('consultation'); }}>Agent consultation<span>Independent answers and citations</span></button><button type="button" className={mode === 'report' ? 'selected' : ''} disabled={busy || awaitingConfirmation} onClick={() => { changed(); setMode('report'); }}>Research report<span>A downloadable Markdown investigation</span></button></div>
    <form className="workspace-form" onSubmit={event => { void prepare(event); }}>
      <label className="field"><span>{mode === 'consultation' ? 'Your question' : 'Research objective'}</span><textarea required maxLength={mode === 'consultation' ? 4000 : 8000} rows={7} value={objective} disabled={busy || awaitingConfirmation} onChange={event => { changed(); setObjective(event.target.value); }} aria-describedby="objective-help" /><small id="objective-help">Define the topic, time period and sources that matter. Do not include passwords, wallet secrets or confidential information.</small></label>
      <div className="field-grid">{mode === 'consultation' && <><label className="field"><span>Agents in the panel</span><select value={panelSize} disabled={busy || awaitingConfirmation} onChange={event => { changed(); const size = Number(event.target.value); setPanelSize(size); setQuorum(value => Math.min(value, size)); }}>{Array.from({ length: 9 }, (_, i) => i + 1).map(value => <option key={value} value={value}>{value} {value === 1 ? 'agent' : 'agents'}</option>)}</select></label><label className="field"><span>Required matching answers</span><select value={quorum} disabled={busy || awaitingConfirmation} onChange={event => { changed(); setQuorum(Number(event.target.value)); }}>{Array.from({ length: panelSize }, (_, i) => i + 1).map(value => <option key={value} value={value}>{value}</option>)}</select></label></>}<label className="field"><span>Minimum citations</span><select value={citations} disabled={busy || awaitingConfirmation} onChange={event => { changed(); setCitations(Number(event.target.value)); }}>{[1, 2, 3, 5, 8, 10, 15, 20].map(value => <option key={value} value={value}>{value} sources</option>)}</select></label></div>
      <div className="form-actions"><button className="button" type="submit" disabled={busy || awaitingConfirmation || !objective.trim()}>{busy ? <Spinner className="spin" /> : <ArrowUpRight />}{review ? 'Get a new quote' : 'Review request'}</button><span className="form-fee">Service price <strong>{liveFee}</strong><small>Live quote confirms the amount.</small></span></div>
    </form>
    {review && <section className="quote-panel" aria-labelledby="quote-heading"><div className="section-label"><span>LIVE QUOTE</span><span className="status-label">{review.record.status}</span></div><h3 id="quote-heading">Review before you authorize.</h3><dl className="quote-facts"><div><dt>Service fee</dt><dd>{formatUnits(BigInt(review.quote.payment.amount), review.quote.payment.decimals ?? 18)} IMD</dd></div><div><dt>Payment network</dt><dd>Ethereum</dd></div><div><dt>Quote expires</dt><dd>{new Date(Number(review.quote.expiresAt) * 1000).toLocaleTimeString('en-GB')}</dd></div></dl><div className="prepared-objective"><span>REQUEST THE AGENTS WILL RECEIVE</span><p>{text(review.input.objective, review.record.objective)}</p></div><details><summary>View the full request and recipient</summary><pre>{JSON.stringify(review.input, null, 2)}</pre><p className="address-line">Payment recipient: {review.quote.payment.payTo}</p></details><p className="notice">Your question and results will be public on IMD. This payment purchases a request; agents may finish with an incomplete or blocked result. No separate CIPHER fee is added.</p><label className="consent"><input type="checkbox" checked={consent} disabled={busy || Boolean(paidOrPending)} onChange={event => setConsent(event.target.checked)} /><span>I have reviewed this request, its price and the public nature of the results.</span></label><div className="quote-wallet">{wallet && <span>Wallet {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}{balance !== null ? ` · ${formatUnits(balance, 18)} IMD` : ''}</span>}{!wallet && <button className="button button-secondary" disabled={busy} onClick={() => { void connect(); }}><Wallet />Connect wallet</button>}<button className="button" disabled={busy || !consent || Boolean(paidOrPending) || quoteExpired} onClick={() => { void pay(); }}><Key />{paidOrPending ? 'Payment submitted' : quoteExpired ? 'Quote expired — review again' : 'Authorize & send request'}</button>{review.record.status !== 'quoted' && <button className="button button-secondary" disabled={busy} onClick={() => { void checkOrder(); }}>Check order status</button>}{retry && <button className="button button-secondary" disabled={busy} onClick={() => { void retryPayment(); }}>Retry the same payment</button>}</div><div className="order-reference"><span>ORDER ID</span><code>{review.record.id}</code><a href="#history">Track in My requests <ArrowUpRight /></a></div></section>}
    {stage && <p className="progress-message" role="status">{busy ? <Spinner className="spin" /> : <Check />}{stage}</p>}{error && <p className="error-message" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <p className="workspace-source">Powered by the official IMD agent service. Wallet approvals and signatures always happen in your wallet. <a href="https://imd.fun/docs/" target="_blank" rel="noopener noreferrer">Read the service documentation <ArrowUpRight /></a></p>
  </div>;
}

type Tracked = { job: JsonObject; panel: JsonObject | null; result: JsonObject | null; order?: JsonObject; readError?: string };
function PanelResults({ panel }: { panel: JsonObject }) {
  const answers = Array.isArray(panel.answers) ? panel.answers : [];
  return <div className="panel-results"><div className="section-label"><span>AGENT ANSWERS</span><span>{answers.length} received</span></div>{answers.length === 0 && <p>No answers have been returned yet.</p>}{answers.map((entry, index) => {
    const answer = object(entry); const seat = object(answer.seat); const citations = Array.isArray(answer.citations) ? answer.citations : [];
    return <article className="agent-answer" key={text(answer.wallet, String(index))}><h4>Answer {index + 1}{text(seat.tokenId) ? ` · Agent #${text(seat.tokenId)}` : ''}</h4><pre className="answer-text">{typeof answer.answer === 'string' ? answer.answer : JSON.stringify(answer.answer ?? {}, null, 2)}</pre>{citations.length > 0 && <ul className="citation-list">{citations.map((citation, i) => { const value = object(citation); const url = safeLink(typeof citation === 'string' ? citation : value.url); return url ? <li key={i}><a href={url} target="_blank" rel="noopener noreferrer">{text(value.title, new URL(url).hostname)} <ArrowUpRight /></a></li> : null; })}</ul>}</article>;
  })}</div>;
}
function JobResults({ tracked }: { tracked: Tracked }) {
  const files = Array.isArray(tracked.result?.files) ? tracked.result.files : [];
  const id = text(tracked.job.id, text(tracked.result?.jobId));
  return <section className="job-results">{tracked.readError && <p className="error-message" role="alert">Results could not be fully read. {tracked.readError} Refresh this job to try again.</p>}<div className="section-label"><span>ACTUAL JOB STATUS</span><span className="status-label">{text(tracked.job.state, text(tracked.result?.state, 'Waiting for admission'))}</span></div>{text(tracked.job.objective) && <p className="job-objective">{text(tracked.job.objective)}</p>}{text(tracked.job.blockedReason) && <p className="notice">{text(tracked.job.blockedReason)}</p>}{tracked.order && <p>Payment / admission: {text(tracked.order.status, 'Pending')}</p>}{id && <a className="text-link" href={`https://explorer.imd.fun/jobs/${id}`} target="_blank" rel="noopener noreferrer">View the original job <ArrowUpRight /></a>}{tracked.panel && <PanelResults panel={tracked.panel} />}{files.map((entry, index) => { const file = object(entry); const hash = text(file.hash); return /^[a-f0-9]{64}$/i.test(hash) && file.mediaType === 'text/markdown' ? <div className="report-file" key={hash}><div><strong>{text(file.name, `Report ${index + 1}`)}</strong><small>Markdown · {typeof file.bytes === 'number' ? `${Math.ceil(file.bytes / 1024)} KB` : 'Verified artifact'}</small><code>SHA-256 {hash}</code></div><a className="button button-secondary" href={`/api/imd?op=artifact&id=${id}&hash=${hash}`}><DownloadSimple />Download report</a></div> : null; })}{tracked.result?.complete === false && <p className="notice">This job is not complete. Available files are the service’s current partial result.</p>}<button className="button button-secondary" onClick={() => download(`cipher-imd-result-${id || 'order'}.json`, JSON.stringify({ job: tracked.job, panel: tracked.panel, result: tracked.result }, null, 2), 'application/json')}><DownloadSimple />Export result</button></section>;
}
export function RequestHistory() {
  const [initial] = useState(() => { try { return { records: loadOrders(), error: '' }; } catch (err) { return { records: [] as RequestRecord[], error: message(err) }; } });
  const [records, setRecords] = useState<RequestRecord[]>(initial.records);
  const [selected, setSelected] = useState<string | null>(null);
  const [tracked, setTracked] = useState<Tracked | null>(null);
  const [lookup, setLookup] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initial.error);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; const update = () => { try { setRecords(loadOrders()); } catch (err) { setError(message(err)); } }; window.addEventListener('cipher-orders-changed', update); return () => { alive.current = false; window.removeEventListener('cipher-orders-changed', update); }; }, []);
  async function fetchJob(id: string, order?: JsonObject) {
    const job = await apiGet<JsonObject>('job', { id });
    let readError = '';
    const optional = async (op: string) => { try { return await apiGet<JsonObject>(op, { id }); } catch (err) { if (!(err instanceof ApiError && err.status === 404)) readError = message(err); return null; } };
    const [panel, result] = await Promise.all([optional('panel'), optional('result')]);
    if (alive.current) setTracked({ job, panel, result, order, readError });
    return job;
  }
  async function refresh(record: RequestRecord) {
    if (busy) return; setBusy(true); setError(''); setSelected(record.id); setTracked(null);
    try {
      let order: JsonObject;
      try { order = await apiGet<JsonObject>('order', { id: record.id }, record.token); }
      catch (err) { if (record.jobId && uuidPattern.test(record.jobId)) { await fetchJob(record.jobId); setError(`Payment status could not be read. The public job is shown below. ${message(err)}`); return; } throw err; }
      const result = object(object(order.admission).result); const id = text(result.jobId, record.jobId);
      let status = text(order.status, record.status);
      if (uuidPattern.test(id)) { const job = await fetchJob(id, order); status = text(job.state, status); }
      else if (alive.current) setTracked({ job: {}, panel: null, result: null, order });
      const updated = { ...record, status, ...(uuidPattern.test(id) ? { jobId: id } : {}) };
      if (updated.jobId || ['admitted', 'expired', 'payment_failed'].includes(text(order.status))) pendingPayments.delete(record.id);
      try { storeRecord(updated); } catch { /* The live result remains available during this page. */ }
    } catch (err) { if (alive.current) setError(message(err)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function lookupJob(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; const id = lookup.trim();
    if (!uuidPattern.test(id)) { setError('Enter a complete IMD job ID.'); return; }
    setBusy(true); setError(''); setSelected(null); setTracked(null);
    try { await fetchJob(id); } catch (err) { if (alive.current) setError(message(err)); }
    finally { if (alive.current) setBusy(false); }
  }
  function forget(record: RequestRecord) {
    if (!window.confirm('Remove this finished order from this browser? Export its public reference first if you want to keep it. This does not cancel or delete the IMD job.')) return;
    try { removeOrder(record.id); window.dispatchEvent(new Event('cipher-orders-changed')); if (selected === record.id) { setSelected(null); setTracked(null); } } catch (err) { setError(message(err)); }
  }
  async function resend(record: RequestRecord) {
    const original = pendingPayments.get(record.id); if (!original || busy) return;
    setBusy(true); setError('');
    try { await original(); } catch (err) { setError(message(err)); } finally { setBusy(false); }
    await refresh(record);
  }
  return <div className="research-shell"><div className="workspace-intro"><span className="eyebrow">TRACK / YOUR REQUESTS</span><h2>Follow the work.</h2><p>Orders created in this browser appear here. Refresh an order to read its payment, admission and job status from IMD.</p></div><div className="history-actions"><button className="button button-secondary" disabled={!records.length} onClick={() => download('cipher-imd-orders.json', publicOrderExport(records), 'application/json')}><DownloadSimple />Export order references</button><p>The export contains public references only. Keep this browser’s data to retain unpaid order access.</p></div><div className="request-list">{records.length === 0 ? <div className="empty-state"><span>[ NO ORDERS IN THIS BROWSER ]</span><p>Your first request will appear after you review a live quote.</p><a href="#request" className="text-link">Create a request <ArrowUpRight /></a></div> : records.map(record => <article className={`request-card ${selected === record.id ? 'selected' : ''}`} key={record.id}><div className="section-label"><span>{record.mode === 'research' ? 'RESEARCH REPORT' : 'AGENT CONSULTATION'}</span><span className="status-label">{record.status}</span></div><h3>{record.objective}</h3><small>{new Date(record.createdAt).toLocaleString('en-GB')}</small><code>{record.id}</code><button className="button button-secondary" disabled={busy} onClick={() => { void refresh(record); }}>Refresh status <ArrowUpRight /></button>{pendingPayments.has(record.id) && <button className="button button-secondary" disabled={busy} onClick={() => { void resend(record); }}>Resend the original payment</button>}{['completed', 'blocked', 'cancelled', 'expired', 'payment_failed'].includes(record.status) && <button className="forget-order" disabled={busy} onClick={() => forget(record)}>Remove local reference</button>}</article>)}</div><form className="job-lookup" onSubmit={event => { void lookupJob(event); }}><label className="field"><span>Read a public IMD job by its ID</span><input value={lookup} maxLength={36} onChange={event => setLookup(event.target.value)} aria-label="Public IMD job ID" /></label><button className="button button-secondary" disabled={busy || !lookup.trim()} type="submit">Read job <ArrowUpRight /></button></form>{busy && <p className="progress-message" role="status"><Spinner className="spin" />Reading the live request…</p>}{error && <p className="error-message" role="alert">{error}</p>}{tracked && <JobResults tracked={tracked} />}</div>;
}
