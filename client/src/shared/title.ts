/** The tab's title and icon, counting who waits for you anywhere in the building (M6 A3). */
import { store } from '../state';
import { stopsInOrder } from '../waiting-all';

/** "(2) demo-web · orca-office": everyone stopped on you in the building, and this floor's done ones nobody looked at. */
export function titleText(waiting: number, name: string | undefined): string {
  return `${waiting ? `(${waiting}) ` : ''}${name ? `${name} · ` : ''}orca-office`;
}

let shownIcon = -1;
let base: HTMLImageElement | null = null;

/** The office's icon with a red count in its corner while anyone waits; the plain one otherwise. */
function renderIcon(needs: number) {
  if (needs === shownIcon) return;
  shownIcon = needs;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (!needs) {
    link.href = '/favicon.svg';
    return;
  }
  const draw = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (!g || !base) return;
    g.drawImage(base, 0, 0, 64, 64);
    g.beginPath();
    g.arc(44, 20, 19, 0, Math.PI * 2);
    g.fillStyle = '#ef476f';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = '#fff';
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '900 26px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(needs > 9 ? '9+' : String(needs), 44, 21);
    if (needs === shownIcon) link.href = c.toDataURL('image/png');
  };
  if (base?.complete) return draw();
  base = new Image();
  base.onload = draw;
  base.src = '/favicon.svg';
}

export function renderTitle() {
  const stops = stopsInOrder(store.waitingAll, store.workers.values(), store.floor);
  document.title = titleText(stops.length, store.project?.name);
  renderIcon(stops.filter((s) => s.needs).length);
}

store.on('waitingAll', renderTitle);
