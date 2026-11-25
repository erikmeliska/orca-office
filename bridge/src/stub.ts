/**
 * Stub mode (ORCA_OFFICE_STUB=1, `npm run dev:stub`): the bridge plays the office server for the 3D
 * client with made-up data, so the client boots without Orca (M1, issue #12). Two floors with a few
 * desks each, and workers in every state the office shows: working (acting out reading, editing,
 * testing and failing tests), needs you and done. No terminals, GitHub, pictures or games: the stub
 * answers only what docs/stub-protocol.md lists. Everything here is fake, nothing is private.
 *
 * Pure: it builds the messages; main.ts sends them and passes in what the page sends.
 */
import { lookFromSeed, sanitizeLook } from '@orca-office/shared/office/avatar';
import { EMPTY_PLAN } from '@orca-office/shared/office/floorplan';
import { elevatorSpot } from '@orca-office/shared/office/layout';
import type {
  ClientMsg,
  FloorInfo,
  FloorView,
  PeerInfo,
  PlanLimits,
  ServerMsg,
  WorkerAction,
  WorkerInfo,
  WorkerStatus,
} from '@orca-office/shared/office/protocol';
import { ROOF } from '@orca-office/shared/office/rooftop';

/** A worker as the stub seats it: who, where, and what it's doing. */
interface FakeWorker {
  id: string;
  name: string;
  color: string;
  deskId: string;
  status: WorkerStatus;
  task: string;
  summary: string;
  /** For a working one, the actions it goes through, one after another (see tick). */
  actions?: WorkerAction[];
}

interface FakeFloor {
  info: Omit<FloorInfo, 'workers' | 'busy' | 'waiting' | 'people'>;
  workers: FakeWorker[];
}

const T0 = Date.UTC(2026, 10, 24, 9, 0);

/** The building: what the client should show for M1 (≥ 2 floors, ≥ 4 desks, every state). */
export const FLOORS: readonly FakeFloor[] = [
  {
    info: { id: 'stub-web', name: 'demo-web', repo: 'example/demo-web', dir: '~/code/demo-web', branch: 'main', palette: 0, addedBy: 'stub', addedAt: T0, wing: 0 },
    workers: [
      { id: 'w-ada', name: 'Ada', color: '#ef476f', deskId: 'desk-1', status: 'working', task: 'Fix Login Redirect', summary: 'Tracing why expired sessions still reach the dashboard', actions: ['read', 'edit', 'test'] },
      { id: 'w-bo', name: 'Bo', color: '#118ab2', deskId: 'desk-2', status: 'working', task: 'Add Dark Mode', summary: 'Running the test suite again', actions: ['test', 'failing', 'edit'] },
      { id: 'w-cy', name: 'Cy', color: '#ffd166', deskId: 'desk-3', status: 'needs_input', task: 'Migrate Settings Table', summary: 'Asking before it drops the old column' },
      { id: 'w-di', name: 'Di', color: '#06d6a0', deskId: 'desk-4', status: 'done', task: 'Update README', summary: 'Wrote the new install steps' },
      { id: 'w-ed', name: 'Ed', color: '#8338ec', deskId: 'desk-6', status: 'idle', task: 'Waiting For A Prompt', summary: 'Ready for its first task' },
    ],
  },
  {
    info: { id: 'stub-api', name: 'demo-api', repo: 'example/demo-api', dir: '~/code/demo-api', branch: 'main', palette: 1, addedBy: 'stub', addedAt: T0, wing: 0 },
    workers: [
      { id: 'w-fa', name: 'Fa', color: '#f78c6b', deskId: 'desk-1', status: 'working', task: 'Speed Up Search', summary: 'Reading the query planner output', actions: ['read', 'web', 'edit'] },
      { id: 'w-gu', name: 'Gu', color: '#4f86f7', deskId: 'desk-2', status: 'needs_input', task: 'Rotate API Keys', summary: 'Wants permission to run the migration' },
      { id: 'w-ha', name: 'Ha', color: '#073b4c', deskId: 'desk-5', status: 'done', task: 'Review PR #42', summary: 'Left three comments on the pull request' },
    ],
  },
];

const ACTIVITY: Partial<Record<WorkerAction, string>> = { read: 'Read', edit: 'Edit', test: 'Bash: npm test', failing: 'Bash: npm test', web: 'WebFetch' };

/** One worker as the office protocol has it, `step` turns into its action. */
export function workerInfo(w: FakeWorker, step = 0): WorkerInfo {
  const action = w.actions?.[step % w.actions.length];
  const waiting = w.status === 'needs_input' || w.status === 'done';
  return {
    id: w.id,
    kind: 'agent',
    provider: 'claude',
    deskId: w.deskId,
    name: w.name,
    color: w.color,
    status: w.status,
    acked: false,
    ...(waiting ? { waitingSince: T0 } : {}),
    createdBy: 'stub',
    createdAt: T0,
    cols: 100,
    rows: 30,
    viewers: [],
    viewerIds: [],
    task: { name: w.task, summary: w.summary },
    ...(action ? { action, activity: ACTIVITY[action] } : {}),
    ...(w.status === 'working' ? { workingSince: T0 } : {}),
  };
}

function floorInfo(f: FakeFloor): FloorInfo {
  const busy = f.workers.filter((w) => w.status === 'working').length;
  const waiting = f.workers.filter((w) => w.status === 'needs_input' || w.status === 'done').length;
  return { ...f.info, workers: f.workers.length, busy, waiting, people: 0 };
}

/** Everything on a floor (or the roof, or nowhere: null) for someone arriving there. */
export function floorView(floorId: string | null): FloorView {
  const f = FLOORS.find((x) => x.info.id === floorId);
  return {
    floor: floorId,
    project: f ? { name: f.info.name, dir: f.info.dir, branch: f.info.branch, agentCmd: 'claude', defaultProvider: 'claude', agentProviders: ['claude'] } : null,
    workers: f?.workers.map((w) => workerInfo(w)) ?? [],
    issues: { items: [], fetchedAt: T0, loading: false },
    pulls: { items: [], fetchedAt: T0, loading: false },
    decor: [],
    plan: { ...EMPTY_PLAN, labels: {} },
    services: { items: [] },
    // The floor's dog, sitting in the open between the desks and the lounge.
    dog: f ? { name: 'Rex', coat: 0, breed: 'corgi', path: [[3, 0]], speed: 1.3, elapsed: 0, act: 'sit' } : null,
    cabinet: { player: null, scores: [], frame: null },
    ball: {},
    jail: { prisoners: [], bones: 0 },
  };
}

/** The floors the page can ride to: the stub's, and the roof. */
export function isFloor(id: string): boolean {
  return id === ROOF || FLOORS.some((f) => f.info.id === id);
}

/** One page connected to the stub: who it is and where it stands. */
export class StubSession {
  readonly peer: PeerInfo;
  private step = 0;

  /** `query` is the page's /client URL query (name, color, look, the floor and spot it was on). */
  constructor(id: string, query: URLSearchParams) {
    const n = (k: string) => (query.get(k) ? Number(query.get(k)) : Number.NaN);
    const wanted = query.get('floor');
    const floor = wanted && isFloor(wanted) ? wanted : FLOORS[0]!.info.id;
    // Back where it stood, if it says and it's the floor it was on; else it arrives by elevator.
    const back = wanted === floor && Number.isFinite(n('x')) && Number.isFinite(n('z'));
    const spot = back ? { x: n('x'), y: Number.isFinite(n('y')) ? n('y') : 0, z: n('z'), rotY: Number.isFinite(n('rotY')) ? n('rotY') : 0 } : { ...elevatorSpot(), y: 0, rotY: 0 };
    const color = query.get('color') ?? '';
    this.peer = {
      id,
      name: (query.get('name') ?? '').trim().slice(0, 24) || 'You',
      color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#4f86f7',
      look: sanitizeLook({ skin: n('skin'), hair: n('hair'), style: n('style') }, lookFromSeed(id)),
      ...spot,
      moving: false,
      floor,
    };
  }

  /** The first message: the whole building, and the floor the page is on. */
  welcome(): ServerMsg {
    return {
      t: 'welcome',
      you: this.peer.id,
      peers: [this.peer],
      floors: FLOORS.map(floorInfo),
      projectsDir: { dir: '~/code', custom: false },
      chat: [],
      version: 'stub',
      upgrade: { available: false, phase: 'idle' },
      usage: { total: zeroUsage(), today: zeroUsage(), day: '2026-11-24', pauseHiring: false },
      limits: stubLimits(),
      me: { admin: true },
      notify: {},
      machine: { cpu: 0.2, cores: 8, memUsed: 8e9, memTotal: 16e9, history: [], workers: FLOORS.reduce((s, f) => s + f.workers.length, 0) },
      sky: { lat: 48.15, lon: 17.11, utcOffset: 60, weather: 'clear', intensity: 0 },
      theme: { pick: 'off', active: null },
      map: { pick: 'office', custom: [] },
      prompts: { custom: {} },
      leaveOnMerge: { on: false },
      ...floorView(this.peer.floor ?? null),
    };
  }

  /** What the page sent: the answers to send back (none for most). */
  handle(msg: ClientMsg): ServerMsg[] {
    switch (msg.t) {
      case 'ping':
        return [{ t: 'pong', at: msg.at, now: Date.now() }];
      case 'move':
        Object.assign(this.peer, { x: msg.x, y: msg.y, z: msg.z, rotY: msg.rotY, moving: msg.moving });
        return [];
      case 'floor.go': {
        if (!isFloor(msg.floor) || msg.floor === this.peer.floor) return [];
        const spot = msg.at ?? { ...elevatorSpot(), y: 0, rotY: 0 };
        Object.assign(this.peer, { floor: msg.floor, x: spot.x, y: spot.y, z: spot.z, rotY: spot.rotY, moving: false });
        delete this.peer.seat;
        return [{ t: 'floor.enter', peers: [this.peer], ...floorView(msg.floor) }];
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

  /** Every few seconds: the working workers on the page's floor move on to their next action. */
  tick(): ServerMsg[] {
    this.step++;
    const f = FLOORS.find((x) => x.info.id === this.peer.floor);
    return (f?.workers ?? []).filter((w) => w.actions).map((w) => ({ t: 'worker.update', worker: workerInfo(w, this.step) }));
  }
}

function zeroUsage() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, calls: 0 };
}

/** Made-up plan limits, relative to now so the resets count down (docs/usage.md). */
export function stubLimits(now = Date.now()): PlanLimits {
  const h = 3_600_000;
  return {
    at: now,
    providers: [
      { id: 'claude', name: 'Claude', status: 'ok', plan: 'max', at: now, windows: [{ label: '5h session', pct: 34, resetsAt: now + 2.2 * h }, { label: 'Week', pct: 41, resetsAt: now + 5.6 * 24 * h }, { label: 'Fable week', pct: 12, resetsAt: now + 5.6 * 24 * h }] },
      { id: 'codex', name: 'Codex', status: 'ok', plan: 'pro', at: now, resets: 2, windows: [{ label: '5h session', pct: 18, resetsAt: now + 3.1 * h }, { label: 'Week', pct: 83, resetsAt: now + 2.4 * 24 * h }] },
    ],
  };
}
