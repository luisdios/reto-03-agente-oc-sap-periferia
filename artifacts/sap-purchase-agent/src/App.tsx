import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  Activity, AlertCircle, ArrowDownLeft, ArrowRight, Bot, Check, CheckCircle2, ChevronRight,
  ClipboardCheck, Clock3, FileText, LayoutDashboard, LoaderCircle,
  MessageSquareText, PackageCheck, RefreshCw, Search, Send, ShieldCheck, ShoppingCart,
  Wrench, XCircle,
} from 'lucide-react';
import {
  getGetAgentSessionQueryKey, getGetPurchaseDashboardQueryKey, getListControlEntriesQueryKey,
  getListPurchaseCasesQueryKey, getListPurchaseOrdersQueryKey, useGetAgentSession,
  useGetPurchaseDashboard, useHealthCheck, useListControlEntries, useListPurchaseCases,
  useListPurchaseOrders, useSendAgentMessage,
} from '@workspace/api-client-react';
import type { CaseSummary, ChatMessage, ControlEntry, SessionResponse, ToolCall } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { MessageContent } from '@/components/chat/MessageContent';

const queryClient = new QueryClient();

const navItems = [
  { href: '/', label: 'Panel de casos', icon: LayoutDashboard },
  { href: '/chat', label: 'Asistente de órdenes', icon: MessageSquareText },
  { href: '/orders', label: 'Órdenes SAP', icon: PackageCheck },
  { href: '/control', label: 'Registro de control', icon: ShieldCheck },
];

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const health = useHealthCheck();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><ShoppingCart size={18} strokeWidth={1.8} /></div>
          <div><div className="brand-name">Órdenes SAP</div><div className="brand-sub">GESTIÓN DE COMPRAS</div></div>
        </div>
        <div className="nav-label">Espacio de trabajo</div>
        <nav className="nav-list" aria-label="Navegación principal">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link key={href} href={href} className={`nav-link ${location === href ? 'active' : ''}`} data-testid={`link-${href.slice(1) || 'panel'}`}>
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="system-line"><span className={`dot ${health.data?.ok === false ? 'health-offline' : ''}`} />{health.isLoading ? 'Comprobando conexión' : health.data?.ok === false ? 'Servicio no disponible' : 'Servicio operativo'}</div>
          <div>Los cambios y decisiones quedan registrados para revisión.</div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>Compras</span><ChevronRight size={13} /><span>Operaciones</span></div>
          <div className="top-right"><span>Equipo de administración</span><div className="avatar">EA</div></div>
        </header>
        {children}
      </main>
    </div>
  );
}

function PageHead({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-head"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1><p className="page-subtitle">{subtitle}</p></div>{action}</div>;
}

function Status({ estado }: { estado: string }) {
  const labels: Record<string, string> = { disponible: 'Disponible', creada: 'Orden creada', bloqueada: 'Bloqueada', confirmacion: 'Requiere confirmación' };
  return <span className={`status ${estado}`}>{labels[estado] || estado}</span>;
}

function formatMoney(value: number, currency: string) {
  try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${value.toLocaleString('es-ES')} ${currency}`; }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function ErrorNotice({ onRetry, message = 'No pudimos cargar estos datos.' }: { onRetry: () => void; message?: string }) {
  return <div className="error-banner" role="alert"><span>{message}</span><button className="action-secondary" onClick={onRetry} data-testid="button-retry"><RefreshCw size={13} /> Reintentar</button></div>;
}

function Dashboard() {
  const casesQuery = useListPurchaseCases();
  const dashboardQuery = useGetPurchaseDashboard();
  const controlQuery = useListControlEntries();
  const [filter, setFilter] = useState('');
  const cases = casesQuery.data?.cases ?? [];
  const recent = dashboardQuery.data?.recientes ?? controlQuery.data?.entries ?? [];
  const visibleCases = useMemo(() => cases.filter(item => `${item.solicitudId} ${item.proveedor} ${item.descripcion}`.toLowerCase().includes(filter.toLowerCase())), [cases, filter]);
  const retry = () => { void casesQuery.refetch(); void dashboardQuery.refetch(); void controlQuery.refetch(); };

  return <section className="content">
    <PageHead eyebrow="Centro de operaciones · Compras" title="Panel de casos" subtitle="Revisa los paquetes de compra, identifica qué requiere atención y conserva el control antes de crear una orden." action={<Link href="/chat" className="action-primary" data-testid="link-start-review"><MessageSquareText size={15} /> Revisar un caso <ArrowRight size={14} /></Link>} />
    {(casesQuery.isError || dashboardQuery.isError || controlQuery.isError) && <div style={{ marginBottom: 15 }}><ErrorNotice onRetry={retry} /></div>}
    <div className="metric-grid">
      {[
        ['Casos disponibles', dashboardQuery.data?.totalCasos, 'Paquetes de compra en revisión'],
        ['Órdenes creadas', dashboardQuery.data?.ordenesCreadas, 'Registradas en SAP simulado'],
        ['Pendientes', dashboardQuery.data?.pendientes, 'A la espera de revisión'],
        ['Con bloqueos', dashboardQuery.data?.bloqueadas, 'Necesitan resolver observaciones'],
        ['Retroactivas', dashboardQuery.data?.retroactivas, 'Marcadas para trazabilidad'],
      ].map(([label, value, hint], i) => <div className="panel metric" key={String(label)} data-testid={`metric-${i}`}>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{dashboardQuery.isLoading ? '—' : value ?? '—'}</div>
        <div className="metric-note">{hint}</div>
      </div>)}
    </div>
    <div className="dashboard-grid">
      <section className="panel">
        <div className="panel-head"><div><h2 className="panel-title">Paquetes de compra</h2><div className="panel-kicker" style={{ marginTop: 4 }}>SOLICITUDES DE PRUEBA</div></div>
          <div className="search-field"><Search size={14} /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar solicitud o proveedor" aria-label="Buscar casos" data-testid="input-search-cases" /></div>
        </div>
        {casesQuery.isLoading ? <div aria-label="Cargando casos">{[1, 2, 3, 4].map(i => <div className="skeleton" key={i} />)}</div> :
          casesQuery.isError ? <div className="error-state"><AlertCircle size={20} /><div>No se pudieron cargar los casos.</div><button className="action-secondary" onClick={() => void casesQuery.refetch()}>Volver a intentar</button></div> :
          visibleCases.length === 0 ? <div className="empty-state"><FileText size={22} /><strong>{cases.length ? 'No hay coincidencias' : 'Aún no hay paquetes'}</strong><p>{cases.length ? 'Prueba con otro número de solicitud o proveedor.' : 'Los casos de compra aparecerán aquí cuando estén disponibles.'}</p></div> :
          <div className="case-list">{visibleCases.map(item => <CaseRow key={item.caso} item={item} />)}</div>}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2 className="panel-title">Actividad reciente</h2><div className="panel-kicker" style={{ marginTop: 4 }}>REGISTRO DE CONTROL</div></div><Link href="/control" className="case-open" data-testid="link-control-from-dashboard">Ver registro <ArrowRight size={13} /></Link></div>
        {controlQuery.isLoading && dashboardQuery.isLoading ? <div>{[1, 2, 3].map(i => <div className="skeleton" key={i} />)}</div> :
          recent.length === 0 ? <div className="empty-state"><Clock3 size={22} /><strong>Sin actividad reciente</strong><p>Las acciones verificadas se mostrarán en este registro.</p></div> :
          <div className="recent-list">{recent.slice(0, 6).map((entry, i) => <RecentEntry key={`${entry.solicitudId}-${entry.ts}-${i}`} entry={entry} />)}</div>}
      </section>
    </div>
  </section>;
}

function CaseRow({ item }: { item: CaseSummary }) {
  return <article className="case-row" data-testid={`case-row-${item.solicitudId}`}>
    <div><div className="case-title">{item.proveedor}</div><div className="case-meta"><span className="mono">{item.solicitudId}</span> · {item.descripcion}</div></div>
    <div className="case-right"><div className="case-amount">{formatMoney(item.total, item.moneda)}</div><Status estado={item.estado} /><Link href={`/chat?caso=${encodeURIComponent(item.caso)}`} className="case-open" data-testid={`link-review-${item.solicitudId}`}>Revisar <ArrowRight size={12} /></Link></div>
  </article>;
}

function RecentEntry({ entry }: { entry: ControlEntry }) {
  const success = !!entry.numeroOc;
  return <div className="recent-item" data-testid={`recent-entry-${entry.solicitudId}`}>
    <div className="recent-glyph">{success ? <Check size={14} /> : entry.bloqueos.length ? <AlertCircle size={14} /> : <Activity size={14} />}</div>
    <div className="recent-copy"><div className="recent-line">{entry.solicitudId} · {entry.resultado}</div><div className="recent-detail">{entry.numeroOc ? `Orden ${entry.numeroOc}` : entry.bloqueos.length ? `${entry.bloqueos.length} bloqueo(s)` : 'Revisión registrada'} · {formatDate(entry.ts)}</div></div>
  </div>;
}

function ChatPage() {
  const queryClient = useQueryClient();
  const [sessionId] = useState(() => {
    const key = 'sap-purchase-agent-session';
    const previous = typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
    if (previous) return previous;
    const next = `sesion-${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window !== 'undefined') window.localStorage.setItem(key, next);
    return next;
  });
  const sessionQuery = useGetAgentSession(sessionId, { query: { enabled: !!sessionId, queryKey: getGetAgentSessionQueryKey(sessionId) } });
  const casesQuery = useListPurchaseCases();
  const sendMutation = useSendAgentMessage();
  const [selectedCase, setSelectedCase] = useState('');
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const cases = casesQuery.data?.cases ?? [];
  const transcript = sessionQuery.data?.messages ?? [];
  const selected = cases.find(item => item.caso === selectedCase);
  const pendingCase = sessionQuery.data?.pendingCase;
  const needsConfirmation = sessionQuery.data?.needsConfirmation ?? false;
  const search = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('caso') : null;
  useEffect(() => {
    if (cases.length && !selectedCase) setSelectedCase(search && cases.some(c => c.caso === search) ? search : cases[0].caso);
  }, [cases, selectedCase, search]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [transcript.length, sendMutation.isPending]);

  const transmit = (message: string) => {
    if (!message.trim() || sendMutation.isPending) return;
    const fullMessage = selected ? `Caso seleccionado: ${selected.caso} (${selected.solicitudId}). ${message.trim()}` : message.trim();
    sendMutation.mutate({ data: { sessionId, message: fullMessage } }, {
      onSuccess: response => {
        const now = new Date().toISOString();
        const userMessage: ChatMessage = { id: `${now}-user`, role: 'user', content: fullMessage, createdAt: now, toolCalls: [] };
        const agentMessage: ChatMessage = { id: `${now}-assistant`, role: 'assistant', content: response.reply, createdAt: now, toolCalls: response.toolCalls };
        queryClient.setQueryData<SessionResponse>(getGetAgentSessionQueryKey(sessionId), old => ({
          sessionId: response.sessionId,
          messages: [...(old?.messages ?? transcript), userMessage, agentMessage],
          pendingCase: response.pendingCase,
          needsConfirmation: response.needsConfirmation,
        }));
        void queryClient.invalidateQueries({ queryKey: getGetPurchaseDashboardQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListControlEntriesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getListPurchaseCasesQueryKey() });
        setDraft('');
      },
    });
  };

  return <section className="content">
    <PageHead eyebrow="Asistencia de compras · Revisión guiada" title="Asistente de órdenes" subtitle="Consulta un paquete, revisa los hallazgos y decide con claridad el siguiente paso. Los casos sin excepciones se procesan automáticamente; las excepciones esperan tu confirmación." />
    <div className="chat-layout">
      <aside className="panel chat-cases">
        <div className="eyebrow">Contexto de trabajo</div>
        <label className="select-label" htmlFor="case-select">Caso de compra</label>
        <select id="case-select" className="select-field" value={selectedCase} onChange={e => setSelectedCase(e.target.value)} disabled={casesQuery.isLoading || cases.length === 0} data-testid="select-case">
          {cases.length === 0 && <option value="">Sin casos disponibles</option>}
          {cases.map(item => <option value={item.caso} key={item.caso}>{item.solicitudId} · {item.proveedor}</option>)}
        </select>
        {selected && <div className="selected-case"><h3>{selected.proveedor}</h3><p>{selected.descripcion}</p><div className="selected-amount">{formatMoney(selected.total, selected.moneda)}</div><div style={{ marginTop: 10 }}><Status estado={selected.estado} /></div></div>}
        <div style={{ borderTop: '1px solid #e9e7df', marginTop: 19, paddingTop: 15 }}>
          <div className="select-label">Criterio de trabajo</div>
          <p style={{ fontSize: 11, color: '#77837d', lineHeight: 1.65, margin: '0 0 11px' }}>El agente procesa los casos que pasan los controles. Las excepciones requieren tu confirmación.</p>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 10, color: '#5b7868' }}><ShieldCheck size={14} /> Decisiones trazables</div>
        </div>
      </aside>
      <section className="panel chat-history" aria-label="Conversación con el asistente">
        <div className="chat-header"><div><div className="chat-header-title">Conversación de revisión</div><div className="chat-header-sub">{selected ? `${selected.solicitudId} · ${selected.proveedor}` : 'Selecciona un caso para comenzar'}</div></div><span className="panel-kicker">SESIÓN ACTUAL</span></div>
        {casesQuery.isError && <div className="chat-warning">No se pudieron cargar los casos. Puedes reintentar desde el panel.</div>}
        {sessionQuery.isError && <div className="chat-warning">No se pudo recuperar el historial de esta sesión. Los mensajes nuevos todavía pueden enviarse.</div>}
        <div className="chat-scroll" ref={scrollRef}>
          {sessionQuery.isLoading ? <div style={{ width: '100%' }} aria-label="Cargando conversación">{[1, 2, 3].map(i => <div className="skeleton" key={i} />)}</div> :
            transcript.length === 0 ? <div className="chat-empty"><div className="chat-empty-icon"><Bot size={20} /></div><strong>Una revisión a la vez</strong><p>Elige un caso y cuéntame qué necesitas comprobar. Te mostraré las herramientas utilizadas y cada resultado recibido.</p></div> :
            transcript.map(message => <MessageBubble key={message.id} message={message} />)}
          {sendMutation.isPending && <div className="message"><div className="message-mark"><Bot size={14} /></div><div><div className="bubble" style={{ display: 'flex', alignItems: 'center', gap: 8 }}><LoaderCircle size={14} className="spin" /> Revisando la solicitud…</div></div></div>}
          {sendMutation.isError && <div className="error-banner"><span>No se pudo enviar el mensaje. Revisa la conexión e inténtalo de nuevo.</span><button className="action-secondary" onClick={() => transmit(draft)} data-testid="button-retry-message">Reintentar</button></div>}
        </div>
        {needsConfirmation && <div className="confirm-strip" role="status" data-testid="confirmation-required"><div className="confirm-copy"><strong>Confirmación necesaria</strong>El agente espera tu aprobación para el caso {pendingCase || selected?.caso || 'seleccionado'}.</div><button className="action-primary" onClick={() => transmit(`Confirmo explícitamente la creación de la orden para el caso ${pendingCase || selected?.caso}.`)} disabled={sendMutation.isPending} data-testid="button-confirm-order"><CheckCircle2 size={15} /> Confirmar creación</button></div>}
        <form className="chat-compose" onSubmit={e => { e.preventDefault(); transmit(draft); }}>
          <div className="compose-row"><textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Escribe una instrucción o pregunta sobre el caso…" aria-label="Mensaje para el asistente" data-testid="input-chat-message" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); transmit(draft); } }} />
            <button className="action-primary" type="submit" disabled={!draft.trim() || sendMutation.isPending} aria-label="Enviar mensaje" data-testid="button-send-message">{sendMutation.isPending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}<span>Enviar</span></button></div>
          <div className="compose-hint">Enter para enviar · Mayús + Enter para nueva línea · Las excepciones requieren confirmación.</div>
        </form>
      </section>
    </div>
  </section>;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return <article className={`message ${isUser ? 'user' : ''}`} data-testid={`message-${message.id}`}>
    <div className="message-mark">{isUser ? <ArrowDownLeft size={14} /> : <Bot size={15} />}</div>
    <div style={{ minWidth: 0 }}><div className="bubble">{isUser ? message.content : <MessageContent content={message.content} />}
      {!isUser && message.toolCalls?.length > 0 && <div>{message.toolCalls.map((tool, i) => <ToolCard key={`${tool.name}-${i}`} tool={tool} />)}</div>}
    </div><div className="message-time">{formatDate(message.createdAt)}{!isUser && message.toolCalls?.length ? ` · ${message.toolCalls.length} herramienta(s)` : ''}</div></div>
  </article>;
}

function ToolCard({ tool }: { tool: ToolCall }) {
  return <details className="tool-card" data-testid={`tool-call-${tool.name}`}>
    <summary className="tool-card-head"><span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><Wrench size={12} />{tool.name}</span>{tool.ok ? <span style={{ color: '#44745c', display: 'flex', gap: 4, alignItems: 'center' }}><Check size={11} /> Correcto</span> : <span style={{ color: '#a54f46', display: 'flex', gap: 4, alignItems: 'center' }}><XCircle size={11} /> Con observaciones</span>}</summary>
    <div className="tool-card-body"><div className="tool-label">Parámetros</div><div>{tool.args || 'Sin parámetros'}</div><div className="tool-result"><div className="tool-label">Resultado recibido</div><div>{tool.result || 'Sin detalle de resultado'}</div></div></div>
  </details>;
}

function OrdersPage() {
  const ordersQuery = useListPurchaseOrders();
  const [filter, setFilter] = useState('');
  const orders = ordersQuery.data?.orders ?? [];
  const visibleOrders = orders.filter(order => `${order.numeroOc} ${order.solicitudId} ${order.proveedor}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="content">
    <PageHead eyebrow="SAP simulado · Persistencia" title="Órdenes creadas" subtitle="Órdenes confirmadas y guardadas por el servidor. Consulta su solicitud de origen y marca retroactiva." />
    {ordersQuery.isError && <div style={{ marginBottom: 15 }}><ErrorNotice onRetry={() => void ordersQuery.refetch()} /></div>}
    <section className="panel">
      <div className="panel-head"><div><h2 className="panel-title">Órdenes SAP</h2><div className="panel-kicker" style={{ marginTop: 4 }}>REGISTROS PERSISTIDOS</div></div><div className="toolbar"><span className="panel-kicker">{ordersQuery.isLoading ? 'Cargando…' : `${orders.length} registros`}</span><div className="search-field"><Search size={14} /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar orden o proveedor" aria-label="Buscar órdenes" data-testid="input-search-orders" /></div></div></div>
      {ordersQuery.isLoading ? <div aria-label="Cargando órdenes">{[1, 2, 3, 4].map(i => <div className="skeleton" key={i} />)}</div> :
        visibleOrders.length === 0 ? <div className="empty-state"><PackageCheck size={24} /><strong>{orders.length ? 'No hay coincidencias' : 'Todavía no hay órdenes'}</strong><p>{orders.length ? 'Prueba con otro número de orden o proveedor.' : 'Las órdenes aparecerán aquí una vez confirmadas y guardadas en SAP simulado.'}</p></div> :
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Número OC</th><th>Solicitud de origen</th><th>Proveedor</th><th>Fecha</th><th>Total</th><th>Clasificación</th></tr></thead><tbody>{visibleOrders.map(order => <tr key={order.numeroOc} data-testid={`order-row-${order.numeroOc}`}><td><span className="table-primary mono">{order.numeroOc}</span></td><td className="mono">{order.solicitudId}</td><td className="table-primary">{order.proveedor}</td><td>{formatDate(order.fecha)}</td><td className="mono">{formatMoney(order.total, order.moneda)}</td><td>{order.retroactiva ? <span className="retro-tag">Retroactiva</span> : <span style={{ color: '#75857b', fontSize: 11 }}>Regular</span>}</td></tr>)}</tbody></table></div>}
    </section>
  </section>;
}

function ControlPage() {
  const controlQuery = useListControlEntries();
  const [filter, setFilter] = useState('');
  const [retroOnly, setRetroOnly] = useState(false);
  const entries = controlQuery.data?.entries ?? [];
  const filtered = entries.filter(item => (!retroOnly || item.retroactiva) && `${item.solicitudId} ${item.resultado} ${item.numeroOc ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="content">
    <PageHead eyebrow="Trazabilidad · Revisión" title="Registro de control" subtitle="Un historial consultable de intentos, resultados, bloqueos y confirmaciones, incluidas las órdenes retroactivas." />
    {controlQuery.isError && <div style={{ marginBottom: 15 }}><ErrorNotice onRetry={() => void controlQuery.refetch()} /></div>}
    <section className="panel">
      <div className="panel-head"><div><h2 className="panel-title">Intentos y resultados</h2><div className="panel-kicker" style={{ marginTop: 4 }}>AUDITORÍA DE CASOS</div></div><div className="toolbar"><label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: '#61716d', whiteSpace: 'nowrap' }}><input type="checkbox" checked={retroOnly} onChange={e => setRetroOnly(e.target.checked)} data-testid="filter-retroactive" /> Solo retroactivas</label><div className="search-field"><Search size={14} /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Buscar solicitud o resultado" aria-label="Buscar en control" data-testid="input-search-control" /></div></div></div>
      {controlQuery.isLoading ? <div aria-label="Cargando registro">{[1, 2, 3, 4].map(i => <div className="skeleton" key={i} />)}</div> :
        filtered.length === 0 ? <div className="empty-state"><ClipboardCheck size={24} /><strong>{entries.length ? 'Sin resultados para estos filtros' : 'El registro está vacío'}</strong><p>{entries.length ? 'Ajusta la búsqueda o desactiva el filtro de retroactivas.' : 'Los intentos de revisión y sus resultados aparecerán aquí.'}</p></div> :
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Solicitud</th><th>Resultado</th><th>Número OC</th><th>Revisión</th><th>Bloqueos</th><th>Confirmaciones</th><th>Fecha y hora</th></tr></thead><tbody>{filtered.map((entry, i) => <tr key={`${entry.solicitudId}-${entry.ts}-${i}`} data-testid={`control-row-${entry.solicitudId}-${i}`}><td className="table-primary mono">{entry.solicitudId}</td><td>{entry.resultado}</td><td className="mono">{entry.numeroOc || '—'}</td><td>{entry.retroactiva ? <span className="retro-tag">Retroactiva</span> : <span style={{ color: '#75857b', fontSize: 11 }}>Regular</span>}</td><td>{entry.bloqueos.length ? <span title={entry.bloqueos.join(' · ')} style={{ color: '#995a4e' }}>{entry.bloqueos.length} · {entry.bloqueos.join(', ')}</span> : <span style={{ color: '#71847a' }}>Ninguno</span>}</td><td>{entry.confirmaciones.length ? <span title={entry.confirmaciones.join(' · ')}>{entry.confirmaciones.length} · {entry.confirmaciones.join(', ')}</span> : '—'}</td><td>{formatDate(entry.ts)}</td></tr>)}</tbody></table></div>}
    </section>
  </section>;
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Shell><Switch>
    <Route path="/" component={Dashboard} />
    <Route path="/chat" component={ChatPage} />
    <Route path="/orders" component={OrdersPage} />
    <Route path="/control" component={ControlPage} />
    <Route component={NotFound} />
  </Switch></Shell></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
