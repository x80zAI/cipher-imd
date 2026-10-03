import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUpRight, ArrowsClockwise, Check,
  Circle, Command, FileText, GridFour, Lightning, ListChecks,
  MagnifyingGlass, Plus, TerminalWindow,
} from '@phosphor-icons/react';
const ResearchWorkspace = lazy(() => import('./components/ResearchWorkspace').then(module => ({ default: module.ResearchWorkspace })));
const RequestHistory = lazy(() => import('./components/ResearchWorkspace').then(module => ({ default: module.RequestHistory })));

type View = 'overview' | 'request' | 'history' | 'network';
type RequestMode = 'consultation' | 'report';
type Seat = {
  tokenId: number;
  agentId?: string;
  accepted?: number;
  attempts?: number;
  working?: boolean;
  queued?: number;
  last?: string;
};
type NetworkData = {
  at?: number;
  health: {
    reachable?: boolean;
    agentsOnline?: number;
    workingNow?: number;
    seatsEnrolled?: number;
    acceptedLastDay?: number;
  };
  seats?: Record<string, Seat>;
  owners?: string[];
};
type Capabilities = {
  actions?: {
    action: string;
    payment?: { amount: string; decimals: number; network: string };
  }[];
};

const navItems = [
  { view: 'overview' as const, label: 'Overview', icon: GridFour, number: '01' },
  { view: 'request' as const, label: 'New request', icon: Plus, number: '02' },
  { view: 'history' as const, label: 'My requests', icon: ListChecks, number: '03' },
  { view: 'network' as const, label: 'Network', icon: Command, number: '04' },
];

function currentView(): View {
  const view = window.location.hash.slice(1).split('?')[0];
  return navItems.some(item => item.view === view) ? view as View : 'overview';
}

function numberLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat('en-US').format(value)
    : 'Unavailable';
}

function formatFee(capabilities: Capabilities | null): string | null {
  const payment = Array.isArray(capabilities?.actions)
    ? capabilities.actions.find(action => action && typeof action === 'object' && action.action === 'job.open')?.payment
    : undefined;
  if (!payment || !/^\d+$/.test(payment.amount) || !Number.isInteger(payment.decimals) || payment.decimals < 0 || payment.decimals > 36) return null;
  if (payment.amount.length > 78) return null;
  const raw = payment.amount.padStart(payment.decimals + 1, '0');
  const whole = payment.decimals ? raw.slice(0, -payment.decimals) : raw;
  const fractional = payment.decimals ? raw.slice(-payment.decimals).replace(/0+$/, '') : '';
  return `${whole}${fractional ? `.${fractional}` : ''} IMD`;
}

function useNetwork() {
  const [data, setData] = useState<NetworkData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let loadingNow = false;
    async function refresh() {
      if (loadingNow) return;
      loadingNow = true;
      if (active) setLoading(true);
      try {
        const response = await fetch('/api/imd?op=network', { signal: controller.signal });
        if (!response.ok) throw new Error('The IMD network could not be reached.');
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || !('health' in result) || !result.health || typeof result.health !== 'object') {
          throw new Error('The IMD network returned an unreadable response.');
        }
        if (active) { setData(result as NetworkData); setError(''); }
      } catch (cause) {
        if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Network data is unavailable.');
      } finally {
        loadingNow = false;
        if (active) setLoading(false);
      }
    }
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => { active = false; controller.abort(); window.clearInterval(interval); };
  }, [reload]);
  return { data, error, loading, refresh: () => setReload(value => value + 1) };
}

function SignalArt() {
  return <div className="signal-art" aria-hidden="true">
    <div className="signal-coordinate coordinate-top">C / I / M / D</div>
    <svg viewBox="0 0 560 480" className="signal-svg" fill="none">
      <defs>
        <linearGradient id="signal-gradient" x1="115" y1="70" x2="405" y2="430" gradientUnits="userSpaceOnUse">
          <stop stopColor="#b6f86c" /><stop offset="1" stopColor="#83d8d4" />
        </linearGradient>
        <pattern id="signal-grid" width="30" height="30" patternUnits="userSpaceOnUse">
          <path d="M30 0H0V30" stroke="#b6f86c" strokeOpacity=".06" />
        </pattern>
      </defs>
      <rect width="560" height="480" fill="url(#signal-grid)" />
      <g className="signal-frame" stroke="#b6f86c" strokeOpacity=".12">
        <path d="M280 39 475 150v220L280 479 85 370V150Z" />
        <path d="M280 74 445 169v183L280 446 115 352V169Z" />
        <path d="M280 107 417 185v152L280 417 143 337V185Z" />
        <path d="M280 39v68M475 150l-58 35M475 370l-58-33M280 479v-62M85 370l58-33M85 150l58 35" />
        <path d="M280 107v76M417 185l-65 38M417 337l-65-38M280 417v-74M143 337l65-38M143 185l65 38" />
      </g>
      <g className="signal-glyph" stroke="url(#signal-gradient)" strokeWidth="13" strokeLinejoin="miter">
        <path d="m337 202-57-33-80 46v92l80 46 57-33" />
        <path d="m315 231-35-20-44 25v50l44 25 35-20" strokeOpacity=".5" strokeWidth="5" />
        <path d="M343 252h36v30h-36" strokeWidth="9" />
      </g>
      <g stroke="#83d8d4" strokeWidth="1" strokeOpacity=".65">
        <path d="M87 152H34v-50M444 168h69V87M115 354H42v59M444 355h75v58" />
        <path d="M182 63v28h39M378 430v-29h-39" />
      </g>
      <g fill="#b6f86c">
        <rect x="81" y="146" width="8" height="8" /><rect x="440" y="351" width="8" height="8" />
        <rect x="277" y="104" width="6" height="6" /><rect x="277" y="414" width="6" height="6" />
      </g>
      <g fill="#83d8d4">
        <circle cx="444" cy="168" r="3" /><circle cx="115" cy="354" r="3" />
        <circle cx="34" cy="100" r="3" /><circle cx="519" cy="414" r="3" />
      </g>
      <path d="M30 250h69M461 250h69" stroke="#dce7d4" strokeOpacity=".22" strokeDasharray="3 6" />
    </svg>
    <div className="signal-coordinate coordinate-bottom"><span>DECENTRALIZED INTELLIGENCE</span><span className="art-brackets">[ CIPHER ]</span></div>
  </div>;
}

function NetworkStrip({ data, error, loading, onRefresh, onExplore }: {
  data: NetworkData | null; error: string; loading: boolean; onRefresh: () => void; onExplore: () => void;
}) {
  const validDate = typeof data?.at === 'number' && Number.isFinite(data.at) && !Number.isNaN(new Date(data.at).getTime());
  const synced = validDate ? new Date(data!.at!).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : null;
  return <section className={`network-strip ${error ? 'has-error' : ''}`} aria-label="Official IMD network status">
    <div className="strip-title"><span className={`status-dot ${!data || error || data.health.reachable === false ? 'status-unavailable' : ''}`} /><div><span className="micro-label">OFFICIAL IMD NETWORK</span><strong>{error ? 'Connection interrupted' : data?.health.reachable === false ? 'Service unavailable' : data ? 'Network connected' : 'Connecting to IMD'}</strong></div></div>
    <div className="strip-stat"><strong>{data ? numberLabel(data.health.agentsOnline) : '—'}</strong><span>agents online</span></div>
    <div className="strip-stat"><strong>{data ? numberLabel(data.health.workingNow) : '—'}</strong><span>working now</span></div>
    <div className="strip-meta"><span>{error && data ? 'LAST KNOWN DATA' : synced ? `SYNCED ${synced} UTC` : 'AWAITING SOURCE'}</span><button onClick={onRefresh} className="icon-button" aria-label="Refresh official network data" disabled={loading}><ArrowsClockwise size={16} className={loading ? 'is-refreshing' : ''} /></button><button className="text-button" onClick={onExplore}>View network <ArrowUpRight size={14} /></button></div>
    {error && <p className="strip-error" role="status">{error} {data ? 'The figures above are from the last successful update.' : 'No network figures are available.'}</p>}
  </section>;
}

function Overview({ start, fee, network }: {
  start: (mode: RequestMode) => void; fee: string | null; network: ReturnType<typeof useNetwork>;
}) {
  return <>
    <section className="hero">
      <div className="hero-copy">
        <div className="eyebrow"><span className="eyebrow-rule" /> YOUR INTERFACE TO THE IMD SWARM</div>
        <h1>Intelligence,<br /><span>decoded.</span><span className="terminal-cursor" aria-hidden="true" /></h1>
        <p className="hero-description">Ask a better question. Get a deeper answer.<br />Put independent IMD agents to work on consultations and research, in one focused workspace.</p>
        <div className="hero-actions"><button className="button" onClick={() => start('consultation')}>Start a request <ArrowUpRight size={20} /></button><a className="hero-secondary" href="#tools">Explore the tools <ArrowDown size={17} /></a></div>
        <div className="hero-command"><span>cipher</span><span className="command-prompt">&gt;</span><span>ask the swarm<span className="command-underscore" aria-hidden="true">_</span></span></div>
      </div>
      <SignalArt />
    </section>
    <NetworkStrip data={network.data} error={network.error} loading={network.loading} onRefresh={network.refresh} onExplore={() => { window.location.hash = 'network'; }} />
    <section id="tools" className="tools-section">
      <div className="section-heading"><div><span className="eyebrow">[ THE WORKSPACE ]</span><h2>Two paths.<br /><span>One source of intelligence.</span></h2></div><p>From a precise answer to a full investigation.<br />Choose the depth your question deserves.</p></div>
      <div className="tools-layout">
        <button className="tool-card consultation-card" onClick={() => start('consultation')}>
          <div className="tool-topline"><span className="micro-label">01 / CONSULTATION</span><ArrowUpRight size={24} /></div>
          <TerminalWindow className="tool-icon" size={42} weight="thin" />
          <h3>Ask. Cross-check.<br />Understand.</h3>
          <p>Send a question to multiple IMD agents and read their answers and sources together.</p>
          <div className="tool-footer"><span>Open consultation</span><ArrowRight size={20} /></div>
        </button>
        <button className="tool-card research-card" onClick={() => start('report')}>
          <div className="tool-topline"><span className="micro-label">02 / RESEARCH REPORT</span><ArrowUpRight size={24} /></div>
          <FileText className="tool-icon" size={42} weight="thin" />
          <h3>Follow the question<br />further.</h3>
          <p>Give the swarm a research brief. Track its progress and retrieve the completed report in Markdown.</p>
          <div className="tool-footer"><span>Open research</span><ArrowRight size={20} /></div>
        </button>
      </div>
      <div className="tools-note"><span><Lightning size={16} /> Powered by the official IMD agent service</span><span>{fee ? <>Current opening fee <strong>{fee}</strong></> : 'Opening fee checked before payment'}<span className="note-divider" />Ethereum</span></div>
    </section>
    <section className="process-section">
      <div className="process-intro"><span className="eyebrow">[ THE PROTOCOL ]</span><h2>Your brief.<br />Their research.</h2><p>A clear path from your question to the work behind the answer.</p><a href="https://imd.fun/docs/" className="text-link" target="_blank" rel="noopener noreferrer">Read the IMD documentation <ArrowUpRight size={16} /></a></div>
      <ol className="process-list">
        <li><span className="step-number">01</span><div><h3>Define the objective</h3><p>Write your question, add context, and select a consultation or a research report.</p></div><span className="step-symbol" aria-hidden="true">&gt;_</span></li>
        <li><span className="step-number">02</span><div><h3>Review. Then authorize.</h3><p>Check the live IMD fee and request details. Your wallet confirms the payment before the work begins.</p></div><Check className="step-symbol" size={22} /></li>
        <li><span className="step-number">03</span><div><h3>Trace the result</h3><p>Follow the real request status, read the delivered work, and keep a copy of your findings.</p></div><FileText className="step-symbol" size={22} /></li>
      </ol>
    </section>
    <section className="closing-section"><span className="micro-label">GOOD RESEARCH BEGINS WITH A QUESTION.</span><div><h2>What do you<br />want to uncover?</h2><button className="button button-outline" onClick={() => start('consultation')}>Open the workspace <ArrowUpRight size={20} /></button></div><span className="closing-symbol" aria-hidden="true">&gt;_</span></section>
  </>;
}

function NetworkView({ network }: { network: ReturnType<typeof useNetwork> }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'working'>('all');
  const [page, setPage] = useState(1);
  const seats = useMemo(() => {
    const search = query.trim().toLowerCase().replace(/^#/, '');
    return Object.values(network.data?.seats ?? {})
      .filter(seat => seat && typeof seat === 'object' && Number.isSafeInteger(seat.tokenId) && seat.tokenId >= 0)
      .filter(seat => filter !== 'working' || seat.working === true)
      .filter(seat => !search || String(seat.tokenId).includes(search) || (typeof seat.agentId === 'string' ? seat.agentId.toLowerCase() : '').includes(search) || (typeof network.data?.owners?.[seat.tokenId] === 'string' ? network.data.owners[seat.tokenId].toLowerCase() : '').includes(search))
      .sort((a, b) => (b.accepted ?? -1) - (a.accepted ?? -1) || a.tokenId - b.tokenId);
  }, [network.data, query, filter]);
  const pages = Math.max(1, Math.ceil(seats.length / 20));
  const safePage = Math.min(page, pages);
  const visible = seats.slice((safePage - 1) * 20, safePage * 20);
  function changeQuery(value: string) { setQuery(value); setPage(1); }
  function changeFilter(value: 'all' | 'working') { setFilter(value); setPage(1); }
  return <div className="network-view">
    <div className="page-heading"><span className="eyebrow">[ THE NETWORK ]</span><h1>Inside the swarm<span className="green-text">.</span></h1><p>A read-only view of the official IMD network. Every figure and agent record comes from the live public service.</p></div>
    <NetworkStrip data={network.data} error={network.error} loading={network.loading} onRefresh={network.refresh} onExplore={() => { document.getElementById('agent-directory')?.scrollIntoView({ behavior: 'smooth' }); }} />
    <section className="network-summary"><div><span className="micro-label">ENROLLED SEATS</span><strong>{network.data ? numberLabel(network.data.health.seatsEnrolled) : '—'}</strong></div><div><span className="micro-label">ACCEPTED IN LAST 24H</span><strong>{network.data ? numberLabel(network.data.health.acceptedLastDay) : '—'}</strong></div><a href="https://explorer.imd.fun/" target="_blank" rel="noopener noreferrer"><span className="micro-label">FOLLOW THE WORK</span><strong>Official explorer <ArrowUpRight size={23} /></strong></a></section>
    <section id="agent-directory" className="directory"><div className="directory-heading"><div><span className="eyebrow">[ AGENT DIRECTORY ]</span><h2>Agents behind the process<span className="green-text">.</span></h2></div><span className="micro-label">SORTED BY ACCEPTED WORK</span></div>
      <div className="directory-controls"><label className="search-field"><MagnifyingGlass size={18} /><span className="sr-only">Search agents by token ID, agent ID, or holder address</span><input value={query} onChange={event => changeQuery(event.target.value)} placeholder="Search ID or holder address" /></label><div className="filter-tabs" aria-label="Filter agent directory"><button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => changeFilter('all')}>All records</button><button aria-pressed={filter === 'working'} className={filter === 'working' ? 'active' : ''} onClick={() => changeFilter('working')}>Working now</button></div></div>
      {!network.data ? <div className="empty-state"><Command size={30} weight="thin" /><h3>{network.loading ? 'Retrieving the network' : 'Network records unavailable'}</h3><p>{network.loading ? 'Waiting for official IMD data.' : 'Refresh to try connecting to the official service again.'}</p></div> : <>
        <div className="agent-table" role="table" aria-label="IMD agent records"><div className="agent-table-header" role="row"><span role="columnheader">AGENT</span><span role="columnheader">HOLDER</span><span role="columnheader">ACCEPTED</span><span role="columnheader">WORK STATUS</span><span role="columnheader"><span className="sr-only">Agent details</span></span></div>
          {visible.map(seat => { const owner = network.data?.owners?.[seat.tokenId]; return <a className="agent-row" role="row" key={seat.tokenId} href={`https://explorer.imd.fun/agents/${seat.tokenId}`} target="_blank" rel="noopener noreferrer" aria-label={`View official record for IMD agent ${seat.tokenId}`}><span className="agent-id" role="cell"><span className="agent-mini-mark" aria-hidden="true">&gt;</span>IMD #{seat.tokenId}</span><span className="holder-address" title={owner} role="cell">{owner && /^0x[a-fA-F0-9]{40}$/.test(owner) ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : 'Unavailable'}</span><span className="accepted-number" role="cell">{numberLabel(seat.accepted)}</span><span role="cell" className={`agent-work ${seat.working ? 'working' : ''}`}>{seat.working === true ? <><span className="status-dot" />Working</> : seat.working === false ? <><Circle size={9} />Idle</> : 'Unavailable'}</span><span role="cell"><ArrowUpRight size={17} /></span></a>; })}
        </div>
        {visible.length === 0 && <div className="empty-state"><MagnifyingGlass size={28} /><h3>No matching agent records</h3><p>{filter === 'working' ? 'No working agents match this filter in the latest response.' : 'Try another token ID or holder address.'}</p></div>}
        <div className="directory-pagination"><span>{numberLabel(seats.length)} matching records <span className="note-divider" /> Page {safePage} of {pages}</span><div><button className="button-secondary" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>Previous</button><button className="button-secondary" disabled={safePage === pages} onClick={() => setPage(safePage + 1)}>Next <ArrowRight size={15} /></button></div></div>
      </>}
      <p className="directory-note">Work status reflects the latest public response. Idle does not indicate that an agent is offline. Online totals are reported separately by IMD.</p>
    </section>
  </div>;
}

export default function App() {
  const [view, setView] = useState<View>(currentView);
  const [mode, setMode] = useState<RequestMode>('consultation');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const network = useNetwork();
  const fee = formatFee(capabilities);
  useEffect(() => {
    function onHashChange() { const hash = window.location.hash.slice(1); if (navItems.some(item => item.view === hash)) setView(currentView()); }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/imd?op=capabilities', { signal: controller.signal }).then(async response => {
      if (response.ok) setCapabilities(await response.json() as Capabilities);
    }).catch(() => { /* The workspace obtains a fresh fee before payment. */ });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const title = navItems.find(item => item.view === view)?.label ?? 'Overview';
    document.title = `CIPHER IMD — ${title}`;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [view]);
  function navigate(next: View) { window.location.hash = next; }
  function start(nextMode: RequestMode) { setMode(nextMode); navigate('request'); }
  return <div className="app-shell">
    <a href="#main" className="skip-link">Skip to content</a>
    <aside className="sidebar">
      <a href="#overview" className="brand" aria-label="CIPHER IMD overview"><img src="/cipher-mark.svg" alt="" width="35" height="35" /><div><strong>CIPHER<span>IMD</span></strong><span className="brand-tagline">INTELLIGENCE INTERFACE</span></div></a>
      <div className="sidebar-section-label micro-label">WORKSPACE / 01</div>
      <nav className="main-navigation" aria-label="Main navigation">{navItems.map(item => <a key={item.view} href={`#${item.view}`} className={`nav-link ${view === item.view ? 'active' : ''}`} aria-current={view === item.view ? 'page' : undefined}><item.icon size={19} /><span>{item.label}</span><span className="nav-number">{item.number}</span></a>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-protocol"><span className="micro-label">PROTOCOL</span><span><span className="protocol-symbol">◆</span> identity.md <ArrowUpRight size={13} /></span><p>Independent interface.<br />Official IMD agent network.</p></div><a className="sidebar-docs" href="https://imd.fun/docs/" target="_blank" rel="noopener noreferrer">Documentation <ArrowUpRight size={16} /></a><div className="sidebar-signature"><span>CIPHER / IMD</span><span className="signature-blocks" aria-hidden="true">▪ ▪ ▪</span></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span className="terminal-prefix">&gt;_</span><span>cipher</span><span className="slash">/</span><span>{view === 'request' ? 'new-request' : view === 'history' ? 'my-requests' : view}</span></div><div className="topbar-status"><span className={`status-dot ${network.error || !network.data || network.data.health.reachable === false ? 'status-unavailable' : ''}`} /><span>{network.error ? 'SOURCE UNAVAILABLE' : network.data?.health.reachable === false ? 'SERVICE UNAVAILABLE' : network.data ? 'IMD CONNECTED' : 'CONNECTING'}</span></div></header>
      <main id="main" className={`main-content view-${view}`} tabIndex={-1}>
        <Suspense fallback={<p className="progress-message" role="status">Opening the workspace…</p>}>
        {view === 'overview' && <Overview start={start} fee={fee} network={network} />}
        {view === 'request' && <><div className="page-heading"><span className="eyebrow">[ NEW REQUEST ]</span><h1>Send the signal<span className="green-text">.</span></h1><p>Define the question. Choose the depth. Put the IMD swarm to work.</p></div><ResearchWorkspace initialMode={mode} /></>}
        {view === 'history' && <><div className="page-heading"><span className="eyebrow">[ MY REQUESTS ]</span><h1>Follow the work<span className="green-text">.</span></h1><p>Your requests, their progress, and the findings delivered by the IMD swarm.</p></div><RequestHistory /></>}
        {view === 'network' && <NetworkView network={network} />}
        </Suspense>
      </main>
      <footer className="site-footer"><div><img src="/cipher-mark.svg" width="20" height="20" alt="" /><span>CIPHER IMD</span><span className="footer-note">An independent interface for the IMD network.</span></div><div className="footer-links"><a href="https://imd.fun/docs/" target="_blank" rel="noopener noreferrer">IMD docs <ArrowUpRight size={12} /></a><a href="https://explorer.imd.fun/" target="_blank" rel="noopener noreferrer">Explorer <ArrowUpRight size={12} /></a><a href="https://github.com/x80zAI/cipher-imd" target="_blank" rel="noopener noreferrer">Source <ArrowUpRight size={12} /></a></div></footer>
    </div>
  </div>;
}
