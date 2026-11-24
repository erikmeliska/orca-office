import { PROTOCOL_VERSION } from '@orca-office/shared';
import './live.css';
import {
  applySnapshot,
  applyStatus,
  emptyOffice,
  needsYou,
  workspaceRank,
  type Office,
  type SnapshotMessage,
  type StatusEvent,
  type Workspace,
} from './office-state.js';

// Live list of what Orca reports, until the 3D office lands (M1/M2).
const BRIDGE = `ws://127.0.0.1:${__ORCA_OFFICE_BRIDGE_PORT__}/client`;

let office: Office = emptyOffice();
let bridgeUp = false;
let pluginUp = false;
let showIdle = false;
const flashes = new Map<string, number>();

const app = document.querySelector<HTMLDivElement>('#app')!;

function connect() {
  const ws = new WebSocket(BRIDGE);
  ws.addEventListener('open', () => {
    bridgeUp = true;
    render();
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; plugin?: boolean; name?: string };
    if (msg.type === 'hello' || msg.type === 'bridge') pluginUp = Boolean(msg.plugin);
    if (msg.type === 'snapshot') {
      office = applySnapshot(office, msg as unknown as SnapshotMessage);
      pluginUp = true;
    }
    if (msg.type === 'event' && msg.name === 'agent.status.changed') {
      const e = msg as unknown as StatusEvent;
      if (applyStatus(office, e) && e.payload.workspaceListId) flashes.set(e.payload.workspaceListId, Date.now());
    }
    render();
  });
  ws.addEventListener('close', () => {
    bridgeUp = false;
    pluginUp = false;
    render();
    setTimeout(connect, 2000);
  });
}

function ago(ms: number | null): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function agentChip(a: { agent: string | null; state: string; surface: string; since: number }): string {
  const label = needsYou(a.state as never) ? 'needs you' : a.state;
  return `<span class="chip ${esc(a.state)}" title="${esc(a.surface)} · ${esc(label)} for ${ago(a.since)}">
    <span class="dot"></span>${esc(a.agent ?? 'agent')}${a.surface === 'chat' ? ' 💬' : ' ⌨︎'}
    <span class="muted">${esc(label)} · ${ago(a.since)}</span></span>`;
}

function row(w: Workspace): string {
  const agents = [...w.agents.values()].sort((a, b) => a.state.localeCompare(b.state));
  const flash = (flashes.get(w.id) ?? 0) > Date.now() - 1500 ? ' flash' : '';
  const host = w.hostId && w.hostId !== 'local' ? `<span class="tag">${esc(w.hostId)}</span>` : '';
  return `<div class="desk rank${workspaceRank(w)}${flash}">
    <div class="desk-name">${esc(w.name)}${w.branch && w.branch !== w.name ? `<span class="muted"> ${esc(w.branch)}</span>` : ''}${host}${w.unread ? '<span class="tag unread">unread</span>' : ''}</div>
    <div class="chips">${agents.length ? agents.map(agentChip).join('') : '<span class="muted">empty desk</span>'}</div>
    <div class="muted when">${ago(w.lastActivityAt)}</div>
  </div>`;
}

function render() {
  const all = [...office.workspaces.values()];
  const visible = all.filter((w) => showIdle || w.agents.size > 0);
  const floors = new Map<string, Workspace[]>();
  for (const w of visible) floors.set(w.project, [...(floors.get(w.project) ?? []), w]);
  const sorted = [...floors.entries()]
    .map(([name, ws]) => ({ name, ws: ws.sort((a, b) => workspaceRank(a) - workspaceRank(b) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)) }))
    .sort((a, b) => workspaceRank(a.ws[0]!) - workspaceRank(b.ws[0]!) || a.name.localeCompare(b.name));

  const counts = { needs: 0, working: 0, done: 0 };
  for (const w of all)
    for (const a of w.agents.values()) {
      if (needsYou(a.state)) counts.needs++;
      else if (a.state === 'working') counts.working++;
      else counts.done++;
    }

  app.innerHTML = `
    <header>
      <h1>orca-office <span class="muted">live</span></h1>
      <div class="status">
        <span class="pill ${bridgeUp ? 'ok' : 'bad'}">bridge ${bridgeUp ? 'online' : 'offline'}</span>
        <span class="pill ${pluginUp ? 'ok' : 'bad'}">Orca ${pluginUp ? 'connected' : 'offline'}</span>
        <span class="pill needs">${counts.needs} needs you</span>
        <span class="pill working">${counts.working} working</span>
        <span class="pill done">${counts.done} done</span>
        <label><input type="checkbox" id="idle" ${showIdle ? 'checked' : ''}/> empty desks (${all.length})</label>
      </div>
    </header>
    <main>
      ${
        sorted.length
          ? sorted.map((f) => `<section class="floor"><h2>${esc(f.name)}</h2>${f.ws.map(row).join('')}</section>`).join('')
          : `<p class="muted empty">${bridgeUp ? 'Waiting for the first snapshot from Orca…' : 'Start the bridge: npm run dev:bridge'}</p>`
      }
    </main>
    <footer class="muted">protocol ${PROTOCOL_VERSION} · snapshot ${ago(office.snapshotAt)} ago</footer>`;
  document.querySelector<HTMLInputElement>('#idle')!.onchange = (e) => {
    showIdle = (e.target as HTMLInputElement).checked;
    render();
  };
}

render();
connect();
setInterval(render, 5000);
