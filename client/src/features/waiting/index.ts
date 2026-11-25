/**
 * Who's waiting on you: N (and the count in the Workers panel) takes you to each in turn, and the
 * compass points to the ones you can't see. Also going to a worker's desk, opening its terminal
 * (waking it if it's asleep) and its changes and the search over every terminal.
 */
import * as THREE from 'three';
import { isAsleep } from '@orca-office/shared/office/status';
import type { Ctx } from '../../core/context';
import type { CoreState } from '../../core/ctx';
import type { Parts } from '../../core/parts';
import { waitingOnSomeone } from '../../notify';
import { NextStop, pillLabel, shortFloor, stopsInOrder, type Stop } from '../../waiting-all';
import { store } from '../../state';
import { openChanges } from '../../ui/changes';
import { Compass, type Bearing } from '../../ui/compass';
import { $, closeAllModals, h, modalOpen, toast } from '../../ui/dom';
import { openSearch } from '../../ui/search';
import { openTerminal, type TerminalFind } from '../../ui/terminal';
import { isOrca, openChatAgent, openInOrca } from '../../ui/orca';
import { openBotChat } from '../../ui/bots';

/** Registers N (and the Workers panel's count), the compass's tick ('render') and / (search). */
export function installWaiting(ctx: Ctx, core: CoreState, parts: Pick<Parts, 'worlds' | 'views' | 'actions' | 'travel'>) {
  const { player, camera, net } = ctx;
  const nextStop = new NextStop();
  const compass = new Compass($('compass'));
  /** What the last press of N said, which the next press replaces. */
  let nextToast: HTMLElement | null = null;
  const workerPos = new THREE.Vector3();

  /** Everyone waiting for you in the building, in N's order (see waiting-all.ts). */
  function stops(): Stop[] {
    return stopsInOrder(store.waitingAll, store.workers.values(), store.floor, store.currentFloor()?.name ?? '');
  }

  /** N: to the first one waiting for you anywhere in the building (longest first), and on each press after, the next. */
  function goToNextWaiting() {
    if (core.trip) return;
    const all = stops();
    const s = nextStop.next(all, waitingBeside());
    nextToast?.remove();
    if (!s) {
      nextToast = toast('👍 Nobody is waiting on you');
      return;
    }
    goToStop(s);
    const of = all.length > 1 ? ` (${all.findIndex((x) => x.key === s.key) + 1} of ${all.length})` : '';
    const where = s.floor !== store.floor ? ` on ${shortFloor(s.floorName)}` : '';
    const what = s.kind === 'gate' ? '⚖️ A decision waits for you' : s.needs ? `🙋 ${s.name} needs you` : `✅ ${s.name} is done`;
    nextToast = toast(`${what}${where}${of}.${s.kind === 'gate' ? ' The board says what' : ' E opens its terminal'}`);
  }

  /** Where N (or the banner, or a notification) is taking you on another floor, done once you're there. */
  let headingFor: { stop: Stop; until: number; then?: () => void } | null = null;

  /** Over to a stop: on this floor straight to its desk, on another one by the floor list first. */
  function goToStop(s: Stop, then?: () => void): boolean {
    if (core.trip) return false;
    if (s.floor && s.floor !== store.floor) {
      headingFor = { stop: s, until: Date.now() + 12_000, then };
      parts.travel.switchFloor(s.floor);
      return true;
    }
    const ok = s.workerId ? goToWorker(s.workerId) : standAtDesk(s.deskId);
    if (ok) then?.();
    return ok;
  }

  /** Once you've come onto the floor you were heading for: on to the desk. */
  function arrived() {
    const h = headingFor;
    if (!h) return;
    if (Date.now() > h.until || store.floor !== h.stop.floor) {
      if (Date.now() > h.until) headingFor = null;
      return;
    }
    if (core.trip) return void setTimeout(arrived, 150);
    headingFor = null;
    // The figure's id is the same on its floor; a gate's desk is the seat its board names.
    const ok = h.stop.workerId && store.workers.has(h.stop.workerId) ? goToWorker(h.stop.workerId) : standAtDesk(h.stop.deskId);
    if (ok) h.then?.();
  }
  store.on('floor', () => setTimeout(arrived, 50));

  /** Puts you at desk `deskId` of this floor. */
  function standAtDesk(deskId: string | null): boolean {
    const desk = deskId ? parts.worlds.plan().byId.get(deskId) : undefined;
    if (core.trip || !desk) return false;
    closeAllModals();
    parts.actions.standAt(desk);
    return true;
  }

  /** The banner's click (a stop's key): over to it, wherever it is. */
  function goToKey(key: string) {
    const s = stops().find((x) => x.key === key);
    if (s) goToStop(s);
  }

  /** Puts you behind worker `id`, looking over its shoulder, with any window closed. False when there's no getting there (you're between floors, or it's gone). */
  function goToWorker(id: string): boolean {
    const w = store.workers.get(id);
    const desk = w && parts.worlds.plan().byId.get(w.deskId);
    if (core.trip || !desk) return false;
    closeAllModals();
    parts.actions.standAt(desk);
    return true;
  }

  /** From a notification about worker `id`: over to its desk, with its terminal open to answer it. */
  function answerWorker(id: string) {
    goToWorker(id);
    openWorkerTerminal(id);
  }

  /** From a notification about something on another floor (or a gate): over there, and the terminal open for an agent. */
  function answerStop(key: string) {
    const s = stops().find((x) => x.key === key) ?? store.waitingAll.map((x) => ({ ...x, needs: true })).find((x) => x.key === key);
    if (!s) return;
    goToStop(s, () => s.workerId && openWorkerTerminal(s.workerId));
  }

  /** The waiting worker you're standing at, if any: N skips it while anyone else is waiting. */
  function waitingBeside(): string | undefined {
    let best: string | undefined;
    let bestD = 2.5;
    for (const w of store.workers.values()) {
      const v = parts.views.workerViews.get(w.id);
      if (!v || !waitingOnSomeone(w)) continue;
      const d = v.model.root.getWorldPosition(workerPos).distanceTo(player.pos);
      if (d < bestD) {
        bestD = d;
        best = w.id;
      }
    }
    return best;
  }

  function renderWaiting() {
    const all = stops();
    const el = $('waiting');
    el.classList.toggle('hidden', !all.length);
    el.classList.toggle('all-done', all.every((s) => !s.needs));
    el.classList.toggle('needs-you-now', all.some((s) => s.needs));
    if (all.length) el.replaceChildren(h('span', {}, pillLabel(all, store.floor)), h('span.key', {}, 'N'));
  }
  store.on('waitingAll', renderWaiting);
  $('waiting').addEventListener('click', () => goToNextWaiting());
  ctx.keys.bind({
    code: 'KeyN',
    run: () => {
      goToNextWaiting();
    },
  });

  const bearings: Bearing[] = [];
  const heads: THREE.Vector3[] = [];
  /** Arrows to the waiting workers you can't see from where you're looking. */
  function pointToWaiting(now: number) {
    bearings.length = 0;
    if (!core.trip && !modalOpen()) {
      for (const w of store.workers.values()) {
        const v = parts.views.workerViews.get(w.id);
        if (!v || !waitingOnSomeone(w)) continue;
        const at = v.model.root.getWorldPosition((heads[bearings.length] ??= new THREE.Vector3()));
        at.y += 1.2;
        bearings.push({ id: w.id, name: w.name, status: w.status, at });
      }
    }
    compass.update(camera, bearings, now);
  }
  // Over the frame once it's drawn (the camera's where it's drawn from).
  ctx.ticks.add('render', ({ now }) => pointToWaiting(now));

  /** Opening a sleeping worker's terminal wakes it, so there's nothing to press first. */
  function openWorkerTerminal(id: string, find?: TerminalFind) {
    const w = store.workers.get(id);
    if (!w) return;
    const { actions } = parts;
    // On Orca: a terminal agent's live terminal, or a chat agent's last words (no terminal to open).
    if (isOrca() && w.orca) {
      if (w.orca.bot) return openBotChat(net, w);
      if (!w.orca.terminal) return openChatAgent(net, w);
      return openTerminal(net, id, undefined, find, { orca: () => openInOrca(net, { workerId: id }) });
    }
    if (w.lost) return actions.fixLostWorktree(w);
    if (isAsleep(w.status)) actions.resumeWorker(w);
    openTerminal(net, id, () => openWorkerChanges(id), find);
  }

  /** 🔎 the chat and every terminal; a terminal line opens that terminal right at it. */
  function showSearch() {
    openSearch(openWorkerTerminal);
  }
  // By the character, so it's / on any keyboard layout. The search box opens without it.
  ctx.keys.bind({
    key: '/',
    preventDefault: true,
    run: () => {
      showSearch();
    },
  });

  /** What the worker changed: changed files, diff, commit / discard / open a PR; `repo` for another floor's repository it works in. */
  function openWorkerChanges(id: string, repo?: string) {
    const w = store.workers.get(id);
    if (!w) return;
    if (w.lost) return parts.actions.fixLostWorktree(w);
    openChanges(net, id, () => openWorkerTerminal(id), repo);
  }

  return { goToNextWaiting, goToWorker, goToKey, answerWorker, answerStop, stops, renderWaiting, openWorkerTerminal, openWorkerChanges, showSearch };
}
