/**
 * One office page on the live bridge (M2): like the stub's session (stub.ts), but the building is
 * Orca's (model.ts). On every change the page gets only what changed on its floor: `worker.update`
 * and `worker.remove` per figure, `plan` when the desk signs change, `floors` when the elevator's
 * counts do.
 */
import { lookFromSeed, sanitizeLook } from '@orca-office/shared/office/avatar';
import { elevatorSpot } from '@orca-office/shared/office/layout';
import type { ClientMsg, FloorView, PeerInfo, ServerMsg } from '@orca-office/shared/office/protocol';
import { ROOF } from '@orca-office/shared/office/rooftop';
import type { Building, LiveFloor } from './model.js';

const T0 = Date.UTC(2026, 10, 24);

export function liveFloorView(floorId: string | null, f: LiveFloor | undefined): FloorView {
  return {
    floor: floorId,
    project: f ? { name: f.info.name, dir: f.info.dir, agentCmd: 'claude', defaultProvider: 'claude', agentProviders: ['claude'] } : null,
    workers: f?.workers ?? [],
    issues: { items: [], fetchedAt: T0, loading: false },
    pulls: { items: [], fetchedAt: T0, loading: false },
    decor: [],
    plan: f?.plan ?? { wing: 0, labels: {} },
    services: { items: [], port: 0 },
    dog: f ? { name: 'Rex', coat: 0, breed: 'corgi', path: [[3, 0]], speed: 1.3, elapsed: 0, act: 'sit' } : null,
    cabinet: { player: null, scores: [], frame: null },
    ball: {},
    jail: { prisoners: [], bones: 0 },
  };
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
        return [{ t: 'floor.enter', peers: [this.peer], ...this.view(b) }];
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
      return [...out, { t: 'floor.enter', peers: [this.peer], ...this.view(b) }];
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
    return out;
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
