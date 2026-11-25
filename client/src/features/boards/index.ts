/**
 * The boards on the walls: the issues board, the PR board, the services board and the machine monitor.
 * orca-office dropped agent-office's GitHub board windows, issue cards and task queue (design.md #16);
 * the repo-wide boards came back through the bridge's ForgeAdapter (design.md #17, #38): the issues
 * and PR boards show the repository's open items (else what Orca links to the desks), and the queue
 * whiteboard what no worktree works on yet. E lists them; each opens on its forge.
 */
import type * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { boardHint, onE } from '../../core/hint';
import { store, type Topic } from '../../state';
import { openServices } from '../../ui/services';
import { floorLinks, openLinks } from '../../ui/links';
import { isOrca } from '../../ui/orca';
import { currentProject, openProjectBoard } from '../../ui/project';
import { hasForge, onForge, openForgeBoard, queueState, type ForgeWall } from '../../ui/forge';
import { BoardTexture, ServicesBoardTexture } from './world';
import { MachineTexture } from './machine';
import type { World } from '../../world/world';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    issues: true;
    pulls: true;
    services: true;
    queue: true;
  }
}

export function installBoards(ctx: Ctx) {
  const { office } = ctx;
  // Boards: each draws onto a canvas texture, redrawn whenever what it shows changes. The same
  // texture goes on that board in whichever world you're in (see dressBoards).
  function mountBoard(mesh: THREE.Mesh | undefined, texture: THREE.Texture, render: () => void, topics: Topic[]) {
    if (mesh) showOn(mesh, texture);
    for (const topic of topics) store.on(topic, render);
    render();
  }
  function showOn(mesh: THREE.Mesh, texture: THREE.Texture) {
    const mat = mesh.material as THREE.MeshBasicMaterial;
    if (mat.map === texture) return;
    mat.map = texture;
    mat.needsUpdate = true;
  }
  const inRoom = () => store.currentFloor()?.room === 'project';
  const issuesTex = new BoardTexture('issues');
  issuesTex.unnumbered = inRoom;
  mountBoard(office.boardMeshes.issues, issuesTex.texture, () => issuesTex.render(store.issues), ['issues']);
  const pullsTex = new BoardTexture('pulls');
  pullsTex.unnumbered = inRoom;
  const renderPullsBoard = () => pullsTex.render(store.pulls, store.workers);
  mountBoard(office.boardMeshes.pulls, pullsTex.texture, renderPullsBoard, ['pulls']);
  // PR notes name the desk they came from. Redraw when that changes, not on every worker update.
  let deskLinks = '';
  store.on('workers', () => {
    const k = JSON.stringify([...store.workers.values()].filter((w) => w.worktree).map((w) => [w.worktree!.branch, w.pr?.number, w.name, w.color, w.deskId]));
    if (k === deskLinks) return;
    deskLinks = k;
    renderPullsBoard();
  });
  const servicesTex = new ServicesBoardTexture();
  const renderServicesBoard = () => servicesTex.render(store.services.items, store.workers);
  mountBoard(office.boardMeshes.services, servicesTex.texture, renderServicesBoard, ['services', 'workers']);
  // On Orca the boards carry what Orca links to this floor's desks (#32); E lists them, to open in the browser.
  const linksOf = (kinds: string[]) => floorLinks().filter((l) => kinds.includes(l.kind));
  // In a project room the walls hold its decisions and tasks: E opens its board (#30).
  // With a forge board (#38) its lists, else the desks' links.
  const orcaBoard = (title: string, kinds: string[], wall: ForgeWall) => (currentProject() ? openProjectBoard() : hasForge() ? openForgeBoard(wall) : isOrca() && openLinks(title, linksOf(kinds)));
  ctx.interactions.define('issues', { reach: 9, hint: () => boardHint('📌 Issues board'), use: onE(() => orcaBoard('📌 Issues linked on this floor', ['issue', 'item'], 'issues')) });
  ctx.interactions.define('pulls', { reach: 9, hint: () => boardHint('🔀 Pull request board'), use: onE(() => orcaBoard('🔀 Pull requests linked on this floor', ['pr', 'mr'], 'pulls')) });
  ctx.interactions.define('services', {
    reach: 9,
    hint: () => boardHint('🌐 Services board'),
    use: onE(() => openServices()),
  });
  // The queue (#38): open issues and pull/merge requests no worktree works on yet.
  const queueTex = new BoardTexture('queue');
  const renderQueueBoard = () => queueTex.render(queueState());
  mountBoard(office.boardMeshes.queue, queueTex.texture, renderQueueBoard, ['floor']);
  onForge(renderQueueBoard);
  ctx.interactions.define('queue', { reach: 9, hint: () => boardHint('📋 Queue · no worktree yet'), use: onE(() => (currentProject() ? openProjectBoard() : hasForge() && openForgeBoard('queue'))) });
  // The machine monitor on the west wall.
  const machineTex = new MachineTexture();
  mountBoard(office.machineScreen, machineTex.texture, () => machineTex.render(store.machine), ['machine']);
  /** Puts every board's texture up on `w`'s boards. */
  function dressBoards(w: World) {
    showOn(w.boardMeshes.issues, issuesTex.texture);
    showOn(w.boardMeshes.pulls, pullsTex.texture);
    showOn(w.boardMeshes.services, servicesTex.texture);
    if (w.boardMeshes.queue) showOn(w.boardMeshes.queue, queueTex.texture);
  }

  return { issuesTex, renderPullsBoard, renderServicesBoard, dressBoards };
}
