// The office as a list (M6, roadmap A12): what a phone (or a narrow window) gets instead of the 3D
// office. Everyone in the building who needs you, then who's working and who's done, each with
// Reply (a line typed into a terminal agent) and Open in Orca. The same socket and protocol as the
// 3D office; agent text is only ever the bridge's short bubble.

import './live.css';
import type { OrcaRosterFloor, OrcaRosterWorker, OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import { forgetBridgeToken, openBridge } from './bridge-auth.js';

const BRIDGE = `ws://127.0.0.1:${__ORCA_OFFICE_BRIDGE_PORT__}/client`;

interface State {
  up: boolean;
  orca: boolean;
  waiting: OrcaWaiting[];
  roster: OrcaRosterFloor[];
  /** When the bridge or Orca went away, for "last update 2 min ago". */
  staleSince: number | null;
  /** The row whose reply box is open, its draft, and what became of the last send. */
  replying: string | null;
  draft: string;
  note: { key: string; text: string; ok: boolean } | null;
}

const st: State = { up: false, orca: true, waiting: [], roster: [], staleSince: null, replying: null, draft: '', note: null };
let ws: WebSocket | null = null;
const app = document.querySelector<HTMLDivElement>('#app')!;

async function connect() {
  const sock = await openBridge(BRIDGE);
  if (!sock) return void setTimeout(connect, 2000);
  ws = sock;
  let opened = false;
  sock.addEventListener('open', () => {
    opened = true;
    st.up = true;
    render();
  });
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data)) as { t?: string; [k: string]: unknown };
    if (m.t === 'orca') st.orca = !!m.online;
    else if (m.t === 'orca.waiting') st.waiting = m.items as OrcaWaiting[];
    else if (m.t === 'orca.roster') st.roster = m.floors as OrcaRosterFloor[];
    else if (m.t === 'orca.result' && st.note) {
      // How the last Reply or Open went: only failures come back for typing.
      if (!m.ok) st.note = { ...st.note, text: `Didn't go through (${String(m.error ?? 'failed')})`, ok: false };
    } else return;
    render();
  });
  sock.addEventListener('close', () => {
    if (!opened) forgetBridgeToken();
    st.up = false;
    ws = null;
    render();
    setTimeout(connect, 2000);
  });
}

const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

function ago(ms: number | undefined): string {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k) e.append(k);
  return e;
}

function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Everyone by id, with the floor they're on. */
function everyone(): Map<string, OrcaRosterWorker & { floor: string; floorName: string }> {
  const out = new Map<string, OrcaRosterWorker & { floor: string; floorName: string }>();
  for (const f of st.roster) for (const w of f.workers) out.set(w.id, { ...w, floor: f.floor, floorName: f.name });
  return out;
}

function openInOrca(item: { workerId: string | null; deskId: string | null; floor: string }, key: string) {
  // A gate has no figure: its desk, on its project room's floor (actions go by the page's floor).
  if (item.workerId) send({ t: 'orca.open', workerId: item.workerId });
  else if (item.deskId) {
    send({ t: 'floor.go', floor: item.floor });
    send({ t: 'orca.open', deskId: item.deskId });
  }
  st.note = { key, text: 'Opened in Orca', ok: true };
  render();
}

function replyBox(workerId: string): HTMLElement {
  const input = el('textarea', 'reply-input');
  input.rows = 2;
  input.placeholder = 'Type a line for it, Enter sends';
  input.value = st.draft;
  input.setAttribute('aria-label', 'Reply');
  input.addEventListener('input', () => (st.draft = input.value));
  const go = () => {
    const text = input.value.trim();
    if (!text) return;
    send({ t: 'worker.prompt', workerId, prompt: text });
    st.note = { key: workerId, text: 'Sent', ok: true };
    st.replying = null;
    st.draft = '';
    render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      go();
    }
    if (e.key === 'Escape') {
      st.replying = null;
      render();
    }
  });
  setTimeout(() => input.focus(), 0);
  return el('div', 'reply', input, el('div', 'reply-actions', button('Send', go, 'primary'), button('Cancel', () => ((st.replying = null), render()))));
}

function card(o: { key: string; title: string; where: string; text?: string | null; tone: string; since?: number; workerId: string | null; deskId: string | null; floor: string; canReply: boolean }): HTMLElement {
  const note = st.note?.key === o.key ? el('p', `note ${st.note.ok ? 'ok' : 'bad'}`, st.note.text) : null;
  const actions = el(
    'div',
    'actions',
    o.canReply && st.replying !== o.key ? button('Reply', () => ((st.replying = o.key), (st.draft = ''), (st.note = null), render()), 'primary') : null,
    o.workerId || o.deskId ? button('Open in Orca', () => openInOrca(o, o.key)) : null,
  );
  return el(
    'li',
    `card ${o.tone}`,
    el('div', 'card-head', el('strong', '', o.title), el('span', 'when', ago(o.since))),
    el('div', 'where', o.where),
    o.text ? el('p', 'text', o.text) : null,
    st.replying === o.key && o.workerId ? replyBox(o.workerId) : actions,
    note,
  );
}

function section(title: string, cls: string, items: HTMLElement[], empty: string): HTMLElement {
  return el('section', cls, el('h2', '', `${title} `, el('span', 'count', String(items.length))), items.length ? el('ul', 'cards', ...items) : el('p', 'empty', empty));
}

function render() {
  const stale = !st.up || !st.orca;
  if (stale && st.staleSince === null) st.staleSince = Date.now();
  if (!stale) st.staleSince = null;
  document.body.classList.toggle('stale', stale);
  const people = everyone();
  const needs = st.waiting.map((w) => {
    const p = w.workerId ? people.get(w.workerId) : undefined;
    return card({
      key: w.key,
      title: w.kind === 'gate' ? '⚖️ A decision waits for you' : w.name,
      where: [`🏢 ${w.floorName}`, p?.branch && p.branch !== w.name ? `🌿 ${p.branch}` : ''].filter(Boolean).join(' · '),
      text: w.ask,
      tone: 'needs',
      since: w.since,
      workerId: w.workerId,
      deskId: w.deskId,
      floor: w.floor,
      canReply: !!p?.terminal,
    });
  });
  const listed = new Set(st.waiting.map((w) => w.workerId));
  const rows = (status: string, tone: string) =>
    [...people.values()]
      .filter((w) => w.status === status && !listed.has(w.id))
      .map((w) => card({ key: w.id, title: `${w.bot ? '🤖 ' : ''}${w.name}`, where: [`🏢 ${w.floorName}`, w.branch && w.branch !== w.name ? `🌿 ${w.branch}` : ''].filter(Boolean).join(' · '), text: w.summary, tone, since: w.since, workerId: w.id, deskId: w.deskId, floor: w.floor, canReply: !!w.terminal }));
  const status = !st.up ? 'Reconnecting…' : !st.orca ? 'Orca offline' : '';
  const banner = status ? el('p', 'banner', `${status}${st.staleSince ? ` · last update ${ago(st.staleSince)}${ago(st.staleSince) === 'just now' ? '' : ' ago'}` : ''}`) : '';
  app.replaceChildren(
    el(
      'header',
      '',
      el('h1', '', 'orca-office'),
      el('span', `pill ${needs.length ? 'needs' : 'calm'}`, needs.length ? `🙋 ${needs.length} need${needs.length === 1 ? 's' : ''} you` : '👍 Nobody waiting'),
    ),
    banner,
    el('main', '', section('Needs you', 'needs', needs, 'Nobody is waiting for you.'), section('Working', 'working', rows('working', 'working'), 'Nobody is working right now.'), section('Done', 'done', rows('done', 'done'), 'Nothing finished yet.')),
    el('footer', '', el('a', '', 'Open the 3D office')),
  );
  const a = app.querySelector('footer a') as HTMLAnchorElement;
  a.href = `/?3d=1`;
  // The tab title counts them too.
  document.title = `${needs.length ? `(${needs.length}) ` : ''}orca-office`;
}

render();
void connect();
// "3 min" moves on (not while typing a reply: that would throw the draft's caret about).
setInterval(() => st.replying === null && render(), 15_000);
