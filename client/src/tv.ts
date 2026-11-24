import './tv.css';
import type { LanDesk, LanFigure, LanFloor, LanServerMsg, LanView } from '@orca-office/shared/office/protocol/lan';

/**
 * The read-only LAN view (#39): served by the bridge's LAN port (`/`, `/tv`), for a TV across the
 * room (LG webOS browser) or a phone. No pointer lock, no keyboard: it goes round the floors by itself,
 * the busiest first; tapping a floor holds it for a minute. It can do nothing in Orca: the socket only
 * gets the building's states and takes pings (bridge/src/lan.ts).
 */
const CYCLE_MS = 12_000;
const HOLD_MS = 60_000;
const STATUS: Record<string, string> = { working: 'working', needs_input: 'needs you', done: 'done', idle: 'idle', starting: 'starting' };
const ACTION: Record<string, string> = { read: '📖', edit: '✏️', test: '🧪', web: '🌐', failing: '😩' };

const root = document.getElementById('tv')!;
let view: LanView | null = null;
let connected = false;
let current: string | null = null;
let shownAt = Date.now();
let heldUntil = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The floors worth showing (those with anyone at all), in the order they come round. */
function rotation(floors: LanFloor[]): LanFloor[] {
  const withPeople = floors.filter((f) => f.desks.some((d) => d.figures.length));
  const pool = withPeople.length ? withPeople : floors;
  // The repositories' floors first (as the office arrives), then the Staff floor and project rooms.
  const kind = (f: LanFloor) => (f.room === 'project' ? 2 : f.room === 'staff' ? 1 : 0);
  return [...pool].sort((a, b) => kind(a) - kind(b) || b.waiting - a.waiting || b.busy - a.busy || a.name.localeCompare(b.name));
}

function figure(f: LanFigure): HTMLElement {
  const row = el('div', `fig s-${f.status}`);
  const dot = el('span', 'dot');
  dot.style.background = f.color;
  const who = el('span', 'who', `${f.bot ? '🤖 ' : ''}${f.name}${f.helpers ? ` +${f.helpers}` : ''}${f.remote ? ' 🌐' : ''}`);
  const what = el('span', 'what', `${f.status === 'working' && f.action ? `${ACTION[f.action] ?? ''} ` : ''}${STATUS[f.status] ?? f.status}`);
  row.append(dot, who, what);
  return row;
}

function desk(d: LanDesk): HTMLElement {
  const box = el('div', `desk${d.figures.some((f) => f.status === 'needs_input') ? ' needs' : ''}`);
  if (d.name) box.append(el('div', 'desk-name', d.name));
  if (d.figures.length) box.append(...d.figures.map(figure));
  else box.append(el('div', 'desk-empty', 'empty desk'));
  return box;
}

function badge(cls: string, text: string): HTMLElement {
  return el('span', `badge ${cls}`, text);
}

function render() {
  root.replaceChildren();
  if (!view) {
    root.append(el('div', 'tv-empty', connected ? 'Waiting for the office…' : 'Connecting to the office…'));
    return;
  }
  const floors = rotation(view.floors);
  const floor = floors.find((f) => f.id === current) ?? floors[0];
  current = floor?.id ?? null;
  const top = el('div', 'tv-top');
  const waiting = view.floors.reduce((s, f) => s + f.waiting, 0);
  top.append(el('h1', '', floor ? `${floor.room === 'staff' ? '🤖' : floor.room === 'project' ? '🏗️' : '🏢'} ${floor.name}` : 'orca-office'), el('span', 'grow'));
  if (!view.online || !connected) top.append(badge('off', connected ? 'Orca offline' : 'reconnecting…'));
  if (floor) {
    if (floor.waiting) top.append(badge('needs', `🙋 ${floor.waiting} needs you`));
    if (floor.busy) top.append(badge('busy', `👷 ${floor.busy} working`));
  }
  if (waiting && (!floor || waiting > floor.waiting)) top.append(badge('', `🙋 ${waiting - (floor?.waiting ?? 0)} elsewhere`));
  root.append(top);
  if (!floor) root.append(el('div', 'tv-empty', 'Nobody in the office.'));
  else {
    const grid = el('div', 'tv-desks');
    const desks = [...floor.desks].sort((a, b) => rank(a) - rank(b));
    grid.append(...desks.map(desk));
    root.append(grid);
  }
  const chips = el('div', 'tv-floors');
  for (const f of floors) {
    const chip = el('button', `chip${f.id === current ? ' on' : ''}`);
    chip.type = 'button';
    chip.append(el('span', '', f.name));
    if (f.waiting) chip.append(el('span', 'n', `🙋${f.waiting}`));
    else if (f.busy) chip.append(el('span', '', `👷${f.busy}`));
    chip.addEventListener('click', () => {
      current = f.id;
      shownAt = Date.now();
      heldUntil = Date.now() + HOLD_MS;
      render();
    });
    chips.append(chip);
  }
  const progress = el('div', 'progress');
  const bar = el('i');
  progress.append(bar);
  const foot = el('div', 'tv-foot');
  foot.append(el('span', 'grow', 'orca-office · read only'), el('span', '', new Date(view.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  root.append(chips, progress, foot);
  paintProgress();
}

function rank(d: LanDesk): number {
  if (d.figures.some((f) => f.status === 'needs_input')) return 0;
  if (d.figures.some((f) => f.status === 'working')) return 1;
  return d.figures.length ? 2 : 3;
}

function paintProgress() {
  const bar = root.querySelector<HTMLElement>('.progress > i');
  if (!bar) return;
  const held = Date.now() < heldUntil;
  bar.style.width = held ? '100%' : `${Math.min(100, ((Date.now() - shownAt) / CYCLE_MS) * 100)}%`;
}

/** Next floor round the rotation, unless a tap is holding this one. */
function tick() {
  paintProgress();
  if (!view || Date.now() < heldUntil || Date.now() - shownAt < CYCLE_MS) return;
  const floors = rotation(view.floors);
  if (floors.length < 2) return void (shownAt = Date.now());
  const i = floors.findIndex((f) => f.id === current);
  current = floors[(i + 1) % floors.length]!.id;
  shownAt = Date.now();
  render();
}

let retry = 0;
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/lan`);
  let ping: ReturnType<typeof setInterval> | null = null;
  ws.addEventListener('open', () => {
    connected = true;
    retry = 0;
    ping = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping', at: Date.now() })), 30_000);
    render();
  });
  ws.addEventListener('message', (ev) => {
    let msg: LanServerMsg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.t !== 'lan.view') return;
    view = msg;
    render();
  });
  ws.addEventListener('close', () => {
    connected = false;
    if (ping) clearInterval(ping);
    render();
    setTimeout(connect, Math.min(15_000, 1000 * 2 ** retry++));
  });
}

render();
connect();
setInterval(tick, 500);
