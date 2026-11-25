/**
 * The command palette (Ctrl+K, ⌘K on a Mac): the workers, the office's actions, its boards, the pull
 * requests, issues and services, and the people in it. Enter does it; Shift+Enter walks you over to
 * where it's done first.
 */
import { DESK_BY_ID, DESKS, WING_DESKS, deskSeat, type DeskDef } from '@orca-office/shared/office/layout';
import { isPaletteKey } from '@orca-office/shared/office/palette';
import type { Ctx } from '../../core/context';
import { seatBuilt } from '../../core/floors';
import type { Parts } from '../../core/parts';
import { STATION_INFO } from '../../core/stations';
import { isTyping } from '../../player';
import { store } from '../../state';
import { STATUS_LABEL, toast } from '../../ui/dom';
import { paletteOpen, togglePalette, type PaletteEntry } from '../../ui/palette';
import { openIssue, openPull } from '../../ui/pull';
import { openProjectBoard } from '../../ui/project';
import { openServices, serviceOwner, serviceUrl } from '../../ui/services';
import { IS_MAC } from '../../ui/termkeys';
import type { InteractKind, Interactable } from '../../world/types';

export type PaletteParts = Pick<Parts, 'walking' | 'waiting' | 'actions' | 'hud' | 'hanging' | 'telescope'>;

/** Listens for Ctrl+K (⌘K) on the window. */
export function installPalette(ctx: Ctx, parts: PaletteParts) {
  const { office, player, net } = ctx;
  const walkThen = (...a: Parameters<Parts['walking']['walkThen']>) => parts.walking.walkThen(...a);
  const showSearch = () => parts.waiting.showSearch();

  /** Where you stand to use something of this kind on this floor, like the Issues board. */
  function spotOf(kind: InteractKind): Interactable | undefined {
    return office.interactables.find((it) => it.kind === kind && !it.off);
  }

  /** Where you stand at a desk: behind the worker, looking over their shoulder (as standAt), or by a chair at the meeting table. */
  function deskSpot(desk: DeskDef): { x: number; z: number } | undefined {
    if (desk.room) return office.interactables.find((it) => it.deskId === desk.id);
    return deskSeat(desk, desk.station ? -1.6 : desk.beanbag ? 1.6 : 2.4);
  }

  /** The free desk nearest you, for hiring from the palette. */
  function nearestFreeDesk(): DeskDef | undefined {
    let best: DeskDef | undefined;
    let bestD = Infinity;
    for (const d of [...DESKS, ...WING_DESKS]) {
      if (store.workerAtDesk(d.id) || !office.desks.has(d.id) || !seatBuilt(d.id)) continue;
      const dist = Math.hypot(d.x - player.pos.x, d.z - player.pos.z);
      if (dist < bestD) {
        best = d;
        bestD = dist;
      }
    }
    return best;
  }

  /** An entry that walks you over to `kind`'s spot (Shift+Enter) before doing what Enter does. */
  function at(kind: InteractKind, what: string, entry: Omit<PaletteEntry, 'walk'>): PaletteEntry {
    const it = spotOf(kind);
    return { ...entry, walk: it ? () => walkThen(it, what, entry.open) : undefined };
  }

  /** Everything the palette finds, in the order it lists them before you type. */
  function paletteEntries(): PaletteEntry[] {
    const { waiting, actions, hanging } = parts;
    const out: PaletteEntry[] = [];
    for (const w of store.workers.values()) {
      const desk = DESK_BY_ID.get(w.deskId);
      const spot = desk && deskSpot(desk);
      const open = () => waiting.openWorkerTerminal(w.id);
      out.push({
        icon: desk?.station ? STATION_INFO[desk.station].icon : w.kind === 'shell' ? '🐚' : '🧑‍💻',
        kind: 'Worker',
        title: w.name,
        detail: [w.task?.name !== w.name ? w.task?.name : '', desk?.label, STATUS_LABEL[w.status], w.orca?.branch && w.orca.branch !== w.name ? `🌿 ${w.orca.branch}` : ''].filter(Boolean).join(' · '),
        keywords: [w.title, w.worktree?.branch, w.orca?.branch, store.currentFloor()?.name],
        open,
        walk: desk && spot ? () => walkThen(spot, `${w.name} at ${desk.label}`, open, desk) : undefined,
      });
    }

    // The other floors' figures (A6): Enter goes there, by the floor list.
    for (const f of store.roster) {
      if (f.floor === store.floor) continue;
      for (const r of f.workers) {
        out.push({
          icon: r.bot ? '🤖' : r.status === 'needs_input' ? '🙋' : '🧑‍💻',
          kind: 'Worker',
          title: r.name,
          detail: [`🏢 ${f.name}`, STATUS_LABEL[r.status], r.branch && r.branch !== r.name ? `🌿 ${r.branch}` : ''].filter(Boolean).join(' · '),
          keywords: [f.name, r.branch ?? ''],
          open: () => waiting.goToFigure(f.floor, r.id, r.deskId, r.name),
        });
      }
    }

    const free = nearestFreeDesk();
    const hireAt = (d: DeskDef) => () => actions.hireAtDesk(d.id);
    out.push({
      icon: '✨',
      kind: 'Action',
      title: 'Hire a worker',
      detail: free ? `At ${free.label}, the free desk nearest you` : 'Every desk is taken',
      keywords: ['new worker', 'spawn an agent'],
      open: free ? hireAt(free) : () => toast('Every desk on this floor is taken', 'warn'),
      walk: free ? () => walkThen(deskSpot(free)!, free.label, hireAt(free), free) : undefined,
    });
    out.push({ icon: '⚙️', kind: 'Action', title: 'Settings', keywords: ['preferences', 'options'], open: () => parts.hud.showSettings() });
    out.push({ icon: '🖼️', kind: 'Action', title: 'Hang a picture', detail: 'On a wall of this floor', keywords: ['decorate', 'frame', 'art'], open: hanging.startHanging });
    out.push({ icon: '🔎', kind: 'Action', title: 'Search the chat and every terminal', keywords: ['find'], open: showSearch });

    out.push(at('services', 'the Services board', { icon: '🌐', kind: 'Board', title: 'Services board', detail: 'Dev servers running in this floor’s worktrees', open: () => openServices() }));

    // A project room's walls hold its open tasks and its decisions (#30), not pull requests and issues.
    const room = store.currentFloor()?.room === 'project';
    for (const pr of room ? store.pulls.items : []) {
      out.push(at('pulls', 'the project board', { icon: '🗂️', kind: 'Task', title: pr.title, detail: 'On this project room’s board', open: () => openProjectBoard() }));
    }
    for (const g of room ? store.issues.items : []) {
      out.push(at('issues', 'the project board', { icon: '⚖️', kind: 'Decision', title: g.title.replace(/^⚖️\s*/, ''), detail: 'Waiting for your decision', open: () => openProjectBoard() }));
    }
    for (const pr of room ? [] : store.pulls.items) {
      out.push(
        at('pulls', 'the PR board', {
          icon: '🔀',
          kind: 'PR',
          title: `#${pr.number} ${pr.title}`,
          detail: [pr.isDraft ? 'Draft' : pr.state.toLowerCase(), pr.headRefName, pr.author].join(' · '),
          open: () => openPull(pr, net, actions.boardActions()),
        }),
      );
    }
    for (const issue of room ? [] : store.issues.items) {
      out.push(
        at('issues', 'the Issues board', {
          icon: '📌',
          kind: 'Issue',
          title: `#${issue.number} ${issue.title}`,
          detail: [issue.state.toLowerCase(), ...issue.labels.map((l) => l.name), issue.author].join(' · '),
          open: () => openIssue(issue, net, actions.boardActions()),
        }),
      );
    }
    for (const svc of store.services.items) {
      const board = spotOf('services');
      out.push({
        icon: '🌐',
        kind: 'Service',
        title: svc.title || svc.command,
        detail: [`:${svc.port}`, svc.title && svc.command, serviceOwner(svc).where].filter(Boolean).join(' · '),
        keywords: [String(svc.port), svc.worktree ?? '', svc.branch ?? ''],
        // As its Open ↗ button does. A new tab needs the key press itself, so walking there shows the board instead.
        open: () => window.open(serviceUrl(svc), '_blank', 'noopener'),
        walk: board ? () => walkThen(board, 'the Services board', () => openServices()) : undefined,
      });
    }
    for (const p of store.peers.values()) {
      if (p.id === store.you) continue;
      const floor = store.onMyFloor(p) ? 'On this floor' : `On the ${store.floors.find((f) => f.id === p.floor)?.name ?? 'other'} floor`;
      // As clicking them under "In the office" does: over to them, by elevator if need be.
      out.push({ icon: '🙂', kind: 'Teammate', title: p.name, detail: floor, open: () => parts.walking.walkTo(p.id) });
    }
    return out;
  }

  // Ctrl+K (⌘K on a Mac), from anywhere but a text box or a terminal, where the key is theirs: in a
  // shell, Ctrl+K cuts to the end of the line. In the palette's own box it puts the palette away.
  window.addEventListener('keydown', (e) => {
    if (!isPaletteKey(e, IS_MAC)) return;
    const inPalette = paletteOpen() && !!(e.target as HTMLElement | null)?.closest?.('.modal.palette');
    if (!inPalette && (isTyping(e) || parts.telescope.active)) return;
    e.preventDefault();
    if (!e.repeat) togglePalette(paletteEntries);
  });

  return { paletteEntries };
}
