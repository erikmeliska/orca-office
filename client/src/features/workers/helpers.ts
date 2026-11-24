import * as THREE from 'three';
import { Worker } from '../../world/character';

/** How many helpers stand by one figure; more show as "+N" on a small tag. */
export const MAX_HELPERS = 4;
/** Where they stand, in the seat's space (+z is the desk): beside the chair and behind it. */
const SPOTS: [number, number][] = [
  [-0.8, -0.15],
  [0.8, -0.15],
  [-0.5, -0.8],
  [0.5, -0.8],
];
const SCALE = 0.42;

/**
 * Claude Code's subagents (Task/Agent tool) as small helpers around their figure (design #12,
 * issue #17): as many as it has running, up to MAX_HELPERS, busy, in its colour; past that a "+N".
 */
export class Helpers {
  private models: Worker[] = [];
  private more: THREE.Sprite | null = null;
  private moreN = 0;

  constructor(
    private anchor: THREE.Object3D,
    private color: string,
  ) {}

  /** Shows `n` helpers (0 takes them all away). */
  set(n: number) {
    const shown = Math.min(n, MAX_HELPERS);
    while (this.models.length < shown) {
      const m = new Worker('', this.color);
      const [x, z] = SPOTS[this.models.length];
      m.root.position.set(x, 0, z);
      m.root.scale.setScalar(SCALE);
      // Turned to their figure.
      m.root.rotation.y = Math.atan2(-x, -z);
      m.setStatus('working', false);
      this.anchor.add(m.root);
      this.models.push(m);
    }
    while (this.models.length > shown) {
      const m = this.models.pop()!;
      m.root.removeFromParent();
      m.dispose();
    }
    const extra = Math.max(0, n - MAX_HELPERS);
    if (extra !== this.moreN) {
      this.moreN = extra;
      this.more?.removeFromParent();
      this.more = extra ? tag(`+${extra}`) : null;
      if (this.more) {
        this.more.position.set(0, 0.9, -1.2);
        this.anchor.add(this.more);
      }
    }
  }

  get count(): number {
    return this.models.length;
  }

  /** Whether one's doing something new (see Worker.lively). */
  lively(): boolean {
    return this.models.some((m) => m.lively());
  }

  update(dt: number, t: number) {
    for (const m of this.models) m.update(dt, t);
  }

  dispose() {
    this.set(0);
    this.more?.removeFromParent();
  }
}

/** A small round "+N" label. */
function tag(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2d42';
  g.beginPath();
  g.roundRect(4, 4, 120, 56, 28);
  g.fill();
  g.fillStyle = '#fffaf3';
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(0.5, 0.25, 1);
  return s;
}
