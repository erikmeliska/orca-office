/**
 * Seeing the whole floor at once (M6, roadmap A9): the overview, a camera high over the floor looking
 * down at the desks, which is where you start; and the map (M), a plan of the floor from straight
 * above with each desk's sign and who sits there in their state's colour. A step, a jump or a click
 * puts you back in your own eyes; a desk on the map takes you to it.
 */
import * as THREE from 'three';
import type { DeskDef } from '@orca-office/shared/office/layout';
import { DESK_SIZE, FLOOR } from '@orca-office/shared/office/layout';
import type { WorkerInfo } from '@orca-office/shared/office/protocol';
import { ROOF } from '@orca-office/shared/office/rooftop';
import type { Ctx } from '../../core/context';
import type { CoreState } from '../../core/ctx';
import { seatBuilt } from '../../core/floors';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { h, openModal } from '../../ui/dom';
import './map.css';

/** From the south wall, under the ceiling, down over both rows of desks. */
const FROM = new THREE.Vector3(-4, 6.3, FLOOR.maxZ - 0.5);
const AT = new THREE.Vector3(-5.5, 0, -2.5);

/** A state's colour on the map (as the signs and badges have them). */
const TONE: Record<string, string> = { needs_input: '#ef476f', working: '#ffd166', done: '#06d6a0', idle: '#adb5bd', starting: '#adb5bd' };

export function installOverview(ctx: Ctx, core: CoreState, parts: Pick<Parts, 'worlds' | 'actions'>) {
  const { player } = ctx;
  const canvas = ctx.renderer.domElement;

  /** Whether there's a floor of the office under you to look down at (not the roof, a map of its own, or between floors). */
  const possible = () => parts.worlds.inOffice() && !core.upTop && !core.trip && !!store.floor && store.floor !== ROOF;

  function enter() {
    if (!possible()) return false;
    player.overview = { from: FROM.clone(), at: AT.clone() };
    player.unlock();
    document.body.classList.add('overview');
    return true;
  }
  function leave() {
    player.overview = null;
    document.body.classList.remove('overview');
  }
  player.onOverviewEnd = () => document.body.classList.remove('overview');

  // A click on the scene: back in your own eyes (and the click captures the mouse as always).
  canvas.addEventListener('pointerdown', () => {
    if (player.overview) leave();
  });

  // In on the first floor the page comes to, and V any time after.
  let first = true;
  store.on('floor', () => {
    if (!first) return void (player.overview && !possible() && leave());
    first = false;
    // Once the office has put you in its elevator car (see arrival).
    setTimeout(() => enter(), 300);
  });
  ctx.keys.bind({
    code: 'KeyV',
    run: () => {
      if (player.overview) leave();
      else enter();
    },
  });
  ctx.keys.bind({
    code: 'KeyM',
    run: () => {
      openMap();
    },
  });

  /** M: the floor from straight above, every desk with its sign and who's there. */
  function openMap() {
    if (!parts.worlds.inOffice() || !store.floor || store.floor === ROOF) return;
    const desks = [...parts.worlds.plan().desks, ...parts.worlds.plan().overflow].filter((d) => seatBuilt(d.id) && !d.room && !d.station);
    const byDesk = new Map<string, WorkerInfo>();
    for (const w of store.workers.values()) byDesk.set(w.deskId, w);
    const W = FLOOR.maxX - FLOOR.minX;
    const H = FLOOR.maxZ - FLOOR.minZ;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `${FLOOR.minX} ${FLOOR.minZ} ${W} ${H}`);
    svg.setAttribute('class', 'floor-map');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Map of ${store.currentFloor()?.name ?? 'this floor'}`);
    const el = (tag: string, attrs: Record<string, string | number>) => {
      const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };
    svg.append(el('rect', { x: FLOOR.minX, y: FLOOR.minZ, width: W, height: H, rx: 0.6, class: 'map-floor' }));
    const list = h('ul.map-list');
    const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
    const modal = { close: () => {} };
    const go = (d: DeskDef) => {
      modal.close();
      leave();
      parts.actions.standAt(d);
    };
    const signed = desks.filter((d) => store.floorPlan.labels[d.id] || byDesk.has(d.id));
    for (const d of desks) {
      const w = byDesk.get(d.id);
      const sign = store.floorPlan.labels[d.id]?.text;
      const tone = w ? (TONE[w.status] ?? '#adb5bd') : sign ? '#e9ecef' : '#f8f9fa';
      const g = el('g', { class: `map-desk${w ? ' taken' : ''}${w?.status === 'needs_input' ? ' needs' : ''}`, transform: `translate(${d.x} ${d.z}) rotate(${(-d.rotY * 180) / Math.PI})`, tabindex: w || sign ? 0 : -1 });
      const size = d.beanbag ? { w: 0.9, d: 0.9 } : { w: DESK_SIZE.width, d: DESK_SIZE.depth };
      g.append(el('rect', { x: -size.w / 2, y: -size.d / 2, width: size.w, height: size.d, rx: 0.12, fill: tone }));
      const title = el('title', {});
      title.textContent = [sign ?? w?.name ?? d.label, w ? w.status.replace('_', ' ') : 'free'].join(' · ');
      g.append(title);
      if (w || sign) {
        g.addEventListener('click', () => go(d));
        g.addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && go(d));
      }
      svg.append(g);
    }
    // The same, as a list you can Tab through, the ones that need you first.
    for (const d of signed.sort((a, b) => Number(byDesk.get(b.id)?.status === 'needs_input') - Number(byDesk.get(a.id)?.status === 'needs_input'))) {
      const w = byDesk.get(d.id);
      list.append(
        h(
          'li',
          {},
          h(
            'button.map-row',
            { type: 'button', onclick: () => go(d) },
            h('span.dot', { style: `background:${w ? (TONE[w.status] ?? '#adb5bd') : '#e9ecef'}` }),
            h('span.grow', {}, store.floorPlan.labels[d.id]?.text ?? w?.name ?? d.label),
            h('span.note', {}, w ? (w.status === 'needs_input' ? 'needs you' : w.status) : 'no agent'),
          ),
        ),
      );
    }
    const legend = h('p.note.map-legend', {}, ...Object.entries({ 'needs you': TONE.needs_input!, working: TONE.working!, done: TONE.done! }).map(([k, c]) => h('span', {}, h('span.dot', { style: `background:${c}` }), k)));
    const box = h('div.modal.map', { role: 'dialog', 'aria-label': 'Floor map' }, h('header', {}, h('h2', {}, `🗺️ ${store.currentFloor()?.name ?? 'Floor'}`), close), h('div.body', {}, svg, legend, list));
    const m = openModal(box, { doing: '🗺️ looking at the map' });
    modal.close = () => m.close();
    close.addEventListener('click', () => m.close());
  }

  return { enterOverview: enter, leaveOverview: leave, openMap };
}
