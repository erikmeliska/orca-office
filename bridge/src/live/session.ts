/**
 * One office page on the live bridge (M2): like the stub's session (stub.ts), but the building is
 * Orca's (model.ts). On every change the page gets only what changed on its floor: `worker.update`
 * and `worker.remove` per figure, `plan` when the desk signs change, `floors` when the elevator's
 * counts do.
 */
import { lookFromSeed, sanitizeLook } from '@orca-office/shared/office/avatar';
import { elevatorSpot } from '@orca-office/shared/office/layout';
import type { ClientMsg, FloorView, GhIssue, GhPull, OrcaLink, PeerInfo, ServerMsg } from '@orca-office/shared/office/protocol';
import { ROOF } from '@orca-office/shared/office/rooftop';
import type { Building, LiveFloor } from './model.js';

const T0 = Date.UTC(2026, 10, 24);

export function liveFloorView(floorId: string | null, f: LiveFloor | undefined): FloorView {
  return {
    floor: floorId,
    project: f ? { name: f.info.name, dir: f.info.dir, agentCmd: 'claude', defaultProvider: 'claude', agentProviders: ['claude'] } : null,
    workers: f?.workers ?? [],
    // The floor's wall boards: what Orca links to its desks (#32), not the forge's whole list.
    issues: { items: f ? boardIssues(f.links) : [], fetchedAt: T0, loading: false },
    pulls: { items: f ? boardPulls(f.links) : [], fetchedAt: T0, loading: false },
    decor: [],
    plan: f?.plan ?? { wing: 0, labels: {} },
    services: { items: [], port: 0 },
    dog: f ? { name: 'Rex', coat: 0, breed: 'corgi', path: [[3, 0]], speed: 1.3, elapsed: 0, act: 'sit' } : null,
    cabinet: { player: null, scores: [], frame: null },
    ball: {},
    jail: { prisoners: [], bones: 0 },
  };
}

/** The numbered pull/merge requests and issues linked to a floor's desks, once each. */
function numbered(links: Record<string, OrcaLink[]>, kinds: OrcaLink['kind'][]): { number: number; url: string; title: string }[] {
  const out = new Map<number, { number: number; url: string; title: string }>();
  for (const l of Object.values(links).flat()) {
    const n = Number(l.ref.slice(1));
    if (!kinds.includes(l.kind) || !Number.isInteger(n) || n <= 0 || out.has(n)) continue;
    out.set(n, { number: n, url: l.url ?? '', title: l.title ?? `${l.kind === 'issue' ? 'Issue' : 'Change'} ${l.ref}` });
  }
  return [...out.values()];
}

const ISO0 = new Date(T0).toISOString();

export function boardPulls(links: Record<string, OrcaLink[]>): GhPull[] {
  return numbered(links, ['pr', 'mr']).map((p) => ({ ...p, state: 'OPEN', isDraft: false, author: '', labels: [], reviewDecision: '', headRefName: '', baseRefName: '', createdAt: ISO0, updatedAt: ISO0, additions: 0, deletions: 0, checks: 'none', body: '', closes: [] }));
}

export function boardIssues(links: Record<string, OrcaLink[]>): GhIssue[] {
  return numbered(links, ['issue']).map((i) => ({ ...i, state: 'OPEN', author: '', labels: [], assignees: [], createdAt: ISO0, updatedAt: ISO0, body: '', comments: 0 }));
}

/** The floor to arrive on: the one where most needs you, then most is working. */
export function busiestFloor(b: Building): string | null {
  const best = [...b.floors].sort((x, y) => y.info.waiting - x.info.waiting || y.info.busy - x.info.busy || y.info.workers - x.info.workers)[0];
  return best?.info.id ?? null;
}

export class LiveSession {
  readonly peer: PeerInfo;
  private sentWorkers = new Map<string, string>();
  private sentPlan = '';
  private sentFloors = '';
  private sentLinks = '';

  constructor(id: string, query: URLSearchParams, b: Building) {
    const n = (k: string) => (query.get(k) ? Number(query.get(k)) : Number.NaN);
    const wanted = query.get('floor');
    const floor = wanted && (wanted === ROOF || b.floors.some((f) => f.info.id === wanted)) ? wanted : busiestFloor(b);
    const back = !!floor && wanted === floor && Number.isFinite(n('x')) && Number.isFinite(n('z'));
    const spot = back ? { x: n('x'), y: Number.isFinite(n('y')) ? n('y') : 0, z: n('z'), rotY: Number.isFinite(n('rotY')) ? n('rotY') : 0 } : { ...elevatorSpot(), y: 0, rotY: 0 };
    const color = query.get('color') ?? '';
    this.peer = {
      id,
      name: (query.get('name') ?? '').trim().slice(0, 24) || 'You',
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4f86f7',
      look: sanitizeLook({ skin: n('skin'), hair: n('hair'), style: n('style') }, lookFromSeed(id)),
      ...spot,
      moving: false,
      ...(floor ? { floor } : {}),
    };
  }

  welcome(b: Building, version: string, online: boolean): ServerMsg[] {
    const view = this.view(b);
    return [
      {
        t: 'welcome',
        you: this.peer.id,
        peers: [this.peer],
        floors: b.floors.map((f) => f.info),
        projectsDir: { dir: '~', custom: false },
        chat: [],
        version,
        upgrade: { available: false, phase: 'idle' },
        usage: { total: zeroUsage(), today: zeroUsage(), day: new Date().toISOString().slice(0, 10), pauseHiring: false },
        limits: { windows: [], at: Date.now() },
        me: { admin: true },
        notify: {},
        machine: { cpu: 0, cores: 0, memUsed: 0, memTotal: 0, history: [], workers: b.floors.reduce((s, f) => s + f.workers.length, 0) },
        sky: { lat: 48.15, lon: 17.11, utcOffset: 60, weather: 'clear', intensity: 0 },
        theme: { pick: 'off', active: null },
        map: { pick: 'office', custom: [] },
        prompts: { custom: {} },
        leaveOnMerge: { on: false },
        ...view,
      },
      { t: 'orca', online },
      ...this.linksMsg(b),
    ];
  }

  handle(msg: ClientMsg, b: Building): ServerMsg[] {
    switch (msg.t) {
      case 'ping':
        return [{ t: 'pong', at: msg.at, now: Date.now() }];
      case 'move':
        Object.assign(this.peer, { x: msg.x, y: msg.y, z: msg.z, rotY: msg.rotY, moving: msg.moving });
        return [];
      case 'floor.go': {
        if (msg.floor === this.peer.floor) return [];
        if (msg.floor !== ROOF && !b.floors.some((f) => f.info.id === msg.floor)) return [];
        const spot = msg.at ?? { ...elevatorSpot(), y: 0, rotY: 0 };
        Object.assign(this.peer, { floor: msg.floor, x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY, moving: false });
        delete this.peer.seat;
        return [{ t: 'floor.enter', peers: [this.peer], ...this.view(b) }, ...this.linksMsg(b)];
      }
      case 'sit':
        if (msg.seat) this.peer.seat = msg.seat;
        else delete this.peer.seat;
        return [];
      case 'profile':
        Object.assign(this.peer, { name: msg.name.trim().slice(0, 24) || this.peer.name, color: msg.color, look: sanitizeLook(msg.look, this.peer.look) });
        return [{ t: 'peer.update', peer: this.peer }];
      default:
        return [];
    }
  }

  /** What changed on this page's floor (and the elevator's counts) since it was last told. */
  update(b: Building): ServerMsg[] {
    const out: ServerMsg[] = [];
    const floors = JSON.stringify(b.floors.map((f) => f.info));
    if (floors !== this.sentFloors) {
      this.sentFloors = floors;
      out.push({ t: 'floors', floors: b.floors.map((f) => f.info) });
    }
    // Nowhere yet (Orca had nothing when the page came): in on the busiest floor once there is one.
    if (!this.peer.floor) {
      const id = busiestFloor(b);
      if (!id) return out;
      Object.assign(this.peer, { floor: id, ...elevatorSpot(), y: 0, rotY: 0 });
      return [...out, { t: 'floor.enter', peers: [this.peer], ...this.view(b) }, ...this.linksMsg(b)];
    }
    const f = b.floors.find((x) => x.info.id === this.peer.floor);
    const now = new Map((f?.workers ?? []).map((w) => [w.id, w]));
    for (const id of this.sentWorkers.keys()) {
      if (now.has(id)) continue;
      this.sentWorkers.delete(id);
      out.push({ t: 'worker.remove', workerId: id });
    }
    for (const [id, w] of now) {
      const s = JSON.stringify(w);
      if (this.sentWorkers.get(id) === s) continue;
      this.sentWorkers.set(id, s);
      out.push({ t: 'worker.update', worker: w });
    }
    const plan = JSON.stringify(f?.plan ?? null);
    if (plan !== this.sentPlan) {
      this.sentPlan = plan;
      if (f) out.push({ t: 'plan', plan: f.plan });
    }
    const links = JSON.stringify(f?.links ?? {});
    if (links !== this.sentLinks && f) {
      // The wall boards follow the desks' links.
      const v = liveFloorView(this.peer.floor ?? null, f);
      out.push({ t: 'gh.pulls', state: v.pulls }, { t: 'gh.issues', state: v.issues });
      out.push(...this.linksMsg(b));
    }
    return out;
  }

  /** The desks' links on the page's floor, remembered as sent. */
  private linksMsg(b: Building): ServerMsg[] {
    const id = this.peer.floor;
    const f = b.floors.find((x) => x.info.id === id);
    this.sentLinks = JSON.stringify(f?.links ?? {});
    return id && f ? [{ t: 'orca.links', floor: id, desks: f.links }] : [];
  }

  /** The floor the page is on, remembered as sent. */
  private view(b: Building): FloorView {
    const id = this.peer.floor ?? null;
    const f = b.floors.find((x) => x.info.id === id);
    const v = liveFloorView(id, id === ROOF ? undefined : f);
    this.sentWorkers = new Map(v.workers.map((w) => [w.id, JSON.stringify(w)]));
    this.sentPlan = JSON.stringify(f?.plan ?? null);
    this.sentFloors = JSON.stringify(b.floors.map((x) => x.info));
    if (id === ROOF) v.dog = null;
    return v;
  }
}

function zeroUsage() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };
}
