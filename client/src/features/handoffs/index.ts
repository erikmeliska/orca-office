/**
 * Deliveries between agents (#34, design #26): a dispatch, a question, a reply, "done" or an
 * escalation from Orca's orchestration mailbox flies as an envelope from one desk to another, with
 * its subject (cut to 60 characters by the bridge) on a tag over it. In a project room it goes from
 * a worker's seat to the head of the table or back; on a repository's floor it leaves the worker's
 * desk for the roof, or drops in from it. Only these short moments: no lasting lines between people.
 */
import * as THREE from 'three';
import type { ServerMsg } from '@orca-office/shared/office/protocol';
import type { Ctx } from '../../core/context';

type HandoffMsg = Extract<ServerMsg, { t: 'orca.handoff' }>;

const ICON: Record<HandoffMsg['kind'], string> = { dispatch: '📤', ask: '❓', reply: '💬', worker_done: '✅', escalation: '🚨' };
/** How long a flight takes, how long its tag stays after, how high it arcs and how far up the roof is. */
const FLY_S = 2.4;
const LINGER_S = 2;
const ARC = 1.2;
const UP = 7;
const MAX_FLYING = 4;

interface Flight {
  root: THREE.Group;
  tag: THREE.Sprite;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dispose(): void;
}

export function installHandoffs(ctx: Ctx) {
  const flying: Flight[] = [];
  const paper = new THREE.MeshToonMaterial({ color: '#fffaf3' });
  const seal = new THREE.MeshToonMaterial({ color: '#ef476f' });
  const body = new THREE.BoxGeometry(0.7, 0.04, 0.46);
  const dot = new THREE.CylinderGeometry(0.08, 0.08, 0.05, 12);

  /** Where an envelope starts or lands at a desk: over its seat. */
  function at(deskId: string): THREE.Vector3 | null {
    const d = ctx.world().desks.get(deskId);
    if (!d) return null;
    return d.group.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 2.5, 0));
  }

  function launch(msg: HandoffMsg) {
    if (!ctx.inOffice()) return;
    const a = msg.from ? at(msg.from) : null;
    const b = msg.to ? at(msg.to) : null;
    if (!a && !b) return;
    const from = a ?? b!.clone().add(new THREE.Vector3(0, UP, 0));
    const to = b ?? a!.clone().add(new THREE.Vector3(0, UP, 0));
    while (flying.length >= MAX_FLYING) drop(flying[0]!);
    const root = new THREE.Group();
    const env = new THREE.Mesh(body, paper);
    const s = new THREE.Mesh(dot, seal);
    s.position.y = 0.025;
    root.add(env, s);
    const { sprite, dispose } = tagSprite(`${ICON[msg.kind]} ${msg.subject ?? label(msg.kind)}`);
    sprite.position.y = 0.6;
    root.add(sprite);
    root.position.copy(ctx.reduceMotion.matches ? to : from);
    ctx.scene.add(root);
    flying.push({ root, tag: sprite, from, to, t: ctx.reduceMotion.matches ? FLY_S : 0, dispose });
  }

  function drop(f: Flight) {
    f.root.removeFromParent();
    f.dispose();
    flying.splice(flying.indexOf(f), 1);
  }

  ctx.messages.onAny((msg) => {
    if (msg.t === 'orca.handoff') launch(msg);
    // A new floor: what was flying on the last one is gone.
    if (msg.t === 'floor.enter') for (const f of [...flying]) drop(f);
  });

  ctx.ticks.add('others', ({ dt }) => {
    // An envelope in flight is motion: keep the frame loop at the full rate (#59).
    if (flying.length) ctx.motion.wake();
    for (const f of [...flying]) {
      f.t += dt;
      const k = Math.min(1, f.t / FLY_S);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      f.root.position.lerpVectors(f.from, f.to, e);
      f.root.position.y += Math.sin(Math.PI * e) * ARC;
      f.root.children[0]!.rotation.z = Math.sin(f.t * 9) * 0.25 * (1 - k);
      const fade = f.t - FLY_S;
      (f.tag.material as THREE.SpriteMaterial).opacity = fade > 0 ? Math.max(0, 1 - fade / LINGER_S) : 1;
      if (fade > LINGER_S) drop(f);
    }
  });

  return { flying: () => flying.length };
}

function label(kind: HandoffMsg['kind']): string {
  return { dispatch: 'New task', ask: 'A question', reply: 'A reply', worker_done: 'Done', escalation: 'Needs a hand' }[kind];
}

/** A tag with the subject on it, facing the camera. */
function tagSprite(text: string): { sprite: THREE.Sprite; dispose(): void } {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = '800 40px Nunito, ui-rounded, system-ui, sans-serif';
  g.font = font;
  const w = Math.min(1100, Math.ceil(g.measureText(text).width) + 56);
  c.width = w;
  c.height = 76;
  g.font = font;
  g.fillStyle = '#2b2d42';
  g.beginPath();
  g.roundRect(2, 2, w - 4, 72, 30);
  g.fill();
  g.fillStyle = '#fffaf3';
  g.textBaseline = 'middle';
  g.fillText(text, 28, 40, w - 56);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10;
  sprite.scale.set((w / 76) * 0.42, 0.42, 1);
  return {
    sprite,
    dispose() {
      tex.dispose();
      mat.dispose();
    },
  };
}
