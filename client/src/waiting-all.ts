// Who waits for you anywhere in the building (M6, roadmap A1/A2): agents asking on every floor and
// the open decision gates, from the bridge's `orca.waiting`, together with this floor's own workers
// (the stub bridge sends no `orca.waiting`, and a done worker nobody looked at is only known here).
// N goes through them in order, the pill and the banner count them, the tab title and its icon too.
// No three.js and no page here, so the tests run it as it is.

import type { WorkerInfo } from '@orca-office/shared/office/protocol';
import type { OrcaAsks, OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import { alertDetail } from '@orca-office/shared/office/status';
import { waitingOnSomeone } from './notify';

/** One place N can take you to. */
export interface Stop {
  /** The figure's id, or `gate:<id>`. */
  key: string;
  kind: 'agent' | 'gate';
  floor: string | null;
  floorName: string;
  workerId: string | null;
  deskId: string | null;
  name: string;
  ask: string | null;
  /** Stopped until you answer (an agent asking, a gate), rather than done and not looked at. */
  needs: boolean;
  since: number;
  /** A permission prompt or a question (M7 B1). */
  asks?: OrcaAsks;
  /** A terminal agent on this machine: answerable from the banner. */
  terminal?: boolean;
  /** An Orca agent (the live bridge), which the banner can act on; not the stub's. */
  orca?: boolean;
}

const sinceOf = (w: WorkerInfo) => w.waitingSince ?? w.createdAt;

/** A floor's name short enough for the top bar (a project room is named after its Run's objective). */
export const shortFloor = (name: string) => (name.length > 24 ? `${name.slice(0, 23)}…` : name);

/**
 * Everyone waiting for you, in the order N takes you: the ones stopped on you anywhere in the
 * building, longest first, then this floor's done ones nobody has looked at, longest first.
 */
export function stopsInOrder(all: readonly OrcaWaiting[], local: Iterable<WorkerInfo>, floor: string | null, floorName = ''): Stop[] {
  const workers = [...local];
  const byId = new Map(workers.map((w) => [w.id, w]));
  const needs: Stop[] = all.map((x) => {
    const w = x.floor === floor && x.workerId ? byId.get(x.workerId) : undefined;
    return { ...x, ask: (w && alertDetail(w)) ?? x.ask, needs: true, orca: true };
  });
  // This floor's own, when the bridge doesn't list them (yet, or the stub).
  for (const w of workers) {
    if (w.status !== 'needs_input' || needs.some((s) => s.key === w.id)) continue;
    needs.push({ key: w.id, kind: 'agent', floor, floorName, workerId: w.id, deskId: w.deskId, name: w.name, ask: alertDetail(w) ?? null, needs: true, since: sinceOf(w), ...(w.orca?.asks ? { asks: w.orca.asks } : {}), ...(w.orca?.terminal ? { terminal: true } : {}), ...(w.orca ? { orca: true } : {}) });
  }
  needs.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
  const done = workers
    .filter((w) => w.status === 'done' && waitingOnSomeone(w))
    .sort((a, b) => sinceOf(a) - sinceOf(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map((w): Stop => ({ key: w.id, kind: 'agent', floor, floorName, workerId: w.id, deskId: w.deskId, name: w.name, ask: alertDetail(w) ?? null, needs: false, since: sinceOf(w) }));
  return [...needs, ...done];
}

/** "🙋 2 need you · 1 here, 1 on blog-ai · ✅ 1 done": everyone stopped on you, where they are, and this floor's done ones. */
export function pillLabel(stops: readonly Stop[], floor: string | null): string {
  const needs = stops.filter((s) => s.needs);
  const done = stops.length - needs.length;
  const here = needs.filter((s) => s.floor === floor).length;
  const away = needs.filter((s) => s.floor !== floor);
  const floors = [...new Set(away.map((s) => shortFloor(s.floorName)))];
  const where = !away.length ? '' : !here && floors.length === 1 ? `on ${floors[0]}` : [here && `${here} here`, floors.length === 1 ? `${away.length} on ${floors[0]}` : `${away.length} on other floors`].filter(Boolean).join(', ');
  const need = needs.length ? `🙋 ${needs.length} ${needs.length === 1 ? 'needs' : 'need'} you${where ? ` · ${where}` : ''}` : '';
  return [need, done && `✅ ${done} done`].filter(Boolean).join(' · ');
}

/** How long it has waited, for the banner: nothing for the first minute, then "4 min", "1 h 05 min". */
export function waited(since: number | undefined, now: number): string {
  const min = since === undefined ? 0 : Math.floor((now - since) / 60_000);
  if (min < 1) return '';
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/**
 * What the banner lets you do about it without walking over (M7 B1): Yes / Always / No on a
 * permission prompt, a line of text into a terminal agent's question, or (a chat agent, which has no
 * terminal) open it in Orca. A gate, or an agent on another host, has none: N takes you there.
 */
export type BannerAct = { kind: 'permission' | 'reply' | 'open'; workerId: string; name: string; since: number } | null;

export function bannerAct(s: Stop | undefined): BannerAct {
  if (!s || s.kind !== 'agent' || !s.workerId || !s.orca) return null;
  if (s.terminal) return { kind: s.asks === 'permission' ? 'permission' : 'reply', workerId: s.workerId, name: s.name, since: s.since };
  return { kind: 'open', workerId: s.workerId, name: s.name, since: s.since };
}

export interface BannerText {
  /** The stop it takes you to: whoever has waited longest. */
  id: string;
  /** What it offers to answer it from the banner. */
  act: BannerAct;
  title: string;
  /** What it's asking, where, and for how long. */
  detail: string;
  /** How many more are asking, or ''. */
  more: string;
  /** Changes whenever the banner would read differently. */
  key: string;
}

/** What the banner says about the first of `asking` (stops that need you, longest first), or null with nobody to show. */
export function bannerText(asking: readonly Stop[], floor: string | null, now: number): BannerText | null {
  const s = asking[0];
  if (!s) return null;
  const ask = s.ask?.replace(/\s+/g, ' ').trim();
  const where = s.floor !== floor ? `on ${shortFloor(s.floorName)}` : '';
  const detail = [ask && (ask.length > 90 ? `${ask.slice(0, 89)}…` : ask), where, waited(s.since, now)].filter(Boolean).join(' · ');
  const more = asking.length > 1 ? `+${asking.length - 1} more` : '';
  const title = s.kind === 'gate' ? '⚖️ A decision waits for you' : `${s.name} needs you`;
  const act = bannerAct(s);
  return { id: s.key, act, title, detail, more, key: `${s.key}|${act ? `${act.kind}|` : ''}${title}|${detail}|${more}` };
}

/**
 * One press of N after another: the first stop in line you haven't been to yet this round, and once
 * you've been to them all, the first again. A stop that starts waiting again is new to this round.
 */
export class NextStop {
  private visited = new Map<string, number>();

  /** The one to go to next. `here` is the stop you're standing at, which only comes up if it's the only one. */
  next(stops: readonly Stop[], here?: string): Stop | undefined {
    for (const [key, at] of this.visited) if (!stops.some((s) => s.key === key && s.since === at)) this.visited.delete(key);
    const others = stops.filter((s) => s.key !== here);
    let pick = others.find((s) => !this.visited.has(s.key));
    if (!pick) {
      this.visited.clear();
      pick = others[0] ?? stops[0];
    }
    if (pick) this.visited.set(pick.key, pick.since);
    return pick;
  }
}

/** The ones the page hasn't seen asking before: new since the last look, never the first look's. */
export class FreshStops {
  private seen: Set<string> | null = null;

  take(stops: readonly Stop[]): Stop[] {
    const keys = new Set(stops.filter((s) => s.needs).map((s) => `${s.key}@${s.since}`));
    const fresh = this.seen ? stops.filter((s) => s.needs && !this.seen!.has(`${s.key}@${s.since}`)) : [];
    this.seen = keys;
    return fresh;
  }
}
