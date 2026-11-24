/**
 * The office TV, showing its idle card. In agent-office it showed a screen someone on the floor shared
 * over voice; orca-office has no voice (design.md #16).
 */
import * as THREE from 'three';
import type { Ctx } from '../../core/context';
import { hintTitle } from '../../core/hint';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    tv: true;
  }
}

export function installTv(ctx: Ctx) {
  const tvIdle = (() => {
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 1280, 720);
    grad.addColorStop(0, '#3a0ca3');
    grad.addColorStop(1, '#4cc9f0');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1280, 720);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.font = '900 88px Nunito, ui-rounded, system-ui, sans-serif';
    g.fillText('📺 Office TV', 640, 330);
    g.font = '700 44px Nunito, ui-rounded, system-ui, sans-serif';
    g.fillText('orca-office', 640, 420);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const tvMat = ctx.office.tvScreen.material as THREE.MeshBasicMaterial;
  tvMat.color.set('#ffffff');
  tvMat.map = tvIdle;
  tvMat.toneMapped = false;
  ctx.interactions.define('tv', {
    reach: 10,
    hint: () => ({ k: 'tv', parts: [hintTitle('📺 Office TV')] }),
    use: () => {},
  });

  return {};
}
