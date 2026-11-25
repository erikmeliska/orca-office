/**
 * The frame loop, and the office's own parts of each frame: moving you, what you hear, telling the
 * office where you are, the building, the sky and drawing it all. They're registered before anything
 * else's (see installLoop), so within a phase they come first.
 */
import * as THREE from 'three';
import { EYE_HEIGHT } from '../player';
import { renderCaffeine } from '../features/coffee/meter';
import type { Ctx } from './context';
import type { CoreState } from './ctx';
import type { Parts } from './parts';
import type { Frame } from './registry';
import { FOV } from './scene';
import { FirstPersonBody } from '../world/character/person-first';

/** Covering less ground than this (m/s) since your last footstep, your feet make no sound: a walk is 4.6. */
const QUIET_FEET = 1.2;

/** Registers the office's own ticks: install it before anything else registers one. */
export function installLoop(ctx: Ctx, core: CoreState, parts: Pick<Parts, 'stage' | 'coffee' | 'peers' | 'views' | 'worlds' | 'place'>) {
  // Registered before anything else's, so within a phase they come first.
  ctx.ticks.add('pre', feelTheCoffee);
  ctx.ticks.add('move', ({ dt }) => ctx.player.update(dt));
  ctx.ticks.add('me', moveMe);
  ctx.ticks.add('me', listen);
  ctx.ticks.add('me', tellWhereYouAre);
  ctx.ticks.add('world', updateWorld);
  ctx.ticks.add('env', updateSky);
  ctx.ticks.add('render', drawFrame);
  installMotion(ctx, core);

  let lastSent = { x: 0, y: 0, z: 0, rotY: 0, moving: false, at: 0 };
  let spotSavedAt = 0;
  /** Which half-stride your walk is on, so each one plays a footstep. */
  let stride = 0;
  /** Where you were last frame, and how far and how long you've walked since your last footstep. */
  const walked = { x: 0, z: 0, far: 0, time: 0 };
  /** How fast you were falling, so landing a jump thumps but stepping down a stair doesn't. */
  let fallV = 0;
  const lookDir = new THREE.Vector3();
  const headPos = new THREE.Vector3();
  /** Coffee, and the view's shake easing off. */
  function feelTheCoffee({ dt, now }: Frame) {
    const { me, hands, reduceMotion } = ctx;
    // Coffee: quicker feet, higher jumps, a mug in hand, and maybe the jitters.
    const { caffeine, buzz } = parts.coffee;
    const secs = now / 1000;
    buzz.speed = caffeine.speed(secs);
    buzz.jump = caffeine.jump(secs);
    core.thud = Math.max(0, core.thud - dt * 2.5);
    buzz.jitter = reduceMotion.matches ? 0 : Math.max(caffeine.jitter(secs), core.thud);
    const mug = caffeine.buzzed(secs);
    // Not while both your hands are on something else (the club, at the tee).
    me.holdMug(mug && !ctx.activities.any('bothHands'));
    hands.holdMug(mug);
    renderCaffeine(caffeine, secs);
  }

  /** Your body below you in first person (made on the first frame, once you are). */
  let firstBody: FirstPersonBody | null = null;

  /** You as everyone else sees you, your hands as you see them, and the camera's view. */
  function moveMe({ dt, t }: Frame) {
    const { player, me, hands, camera } = ctx;
    me.root.position.copy(player.pos);
    me.root.position.y += player.stepOffset;
    me.root.rotation.y = player.facing;
    // Holding on to the ladder or a pole (see ctx.view).
    const grip = ctx.view.grip();
    me.setGrip(grip);
    me.update(dt, t, (player.moving && player.grounded) || (grip === 'ladder' && player.moving), !player.grounded && !grip && !ctx.activities.any('hidesHands'), player.effects.speed);
    // In the overview (M6 A9) the camera is up over the floor: you're down there, seen from above.
    const firstPerson = player.view === 'first' && !player.overview;
    // In first person you are the camera; in third, hide yourself when it's zoomed in right behind your head.
    // At the tee the camera's behind the ball, and you're the one holding the club.
    // So is the camera over your shoulder at the dart board or the axe lane.
    // In first person your body's there below you (see FirstPersonBody), unless your hands are busy elsewhere (a car's wheel).
    const ownBody = firstPerson && !ctx.activities.any('takesCamera') && !ctx.activities.any('hidesHands');
    (firstBody ??= new FirstPersonBody(me.rig)).set(ownBody, camera);
    me.root.visible = ownBody || ctx.activities.any('takesCamera') || (!firstPerson && camera.position.distanceTo(headPos.set(player.pos.x, player.pos.y + 1.3, player.pos.z)) > 1.5);
    // In a car, your hands are on the wheel, out of sight.
    if (firstPerson && !ctx.activities.any('hidesHands')) hands.update(dt, t, { yaw: player.camYaw, pitch: player.lookPitch, walkPhase: player.walkPhase, walking: player.moving && player.grounded, airborne: !player.grounded, jitter: player.effects.jitter, grip });
    // What you're doing widens the view (down a pole) or narrows it (at the oche or the line), and once
    // it's set, may take it over (the telescope) or streak its edges (down a pole): see ctx.view.
    const fov = ctx.view.fov(FOV);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 8);
      camera.updateProjectionMatrix();
    }
    ctx.view.update();
  }

  /** What you hear, from where you are, and your footsteps. */
  function listen({ dt }: Frame) {
    const { player, camera, sound } = ctx;
    // Your ears are in your head, facing wherever the camera looks.
    camera.getWorldDirection(lookDir);
    sound.update({ x: player.pos.x, y: player.pos.y + EYE_HEIGHT, z: player.pos.z, fx: lookDir.x, fz: lookDir.z });
    const walking = player.moving && player.grounded;
    walked.far = walking ? walked.far + Math.hypot(player.pos.x - walked.x, player.pos.z - walked.z) : 0;
    walked.time = walking ? walked.time + dt : 0;
    walked.x = player.pos.x;
    walked.z = player.pos.z;
    const s = Math.floor(player.walkPhase / Math.PI);
    if (s !== stride) {
      stride = s;
      // Only for ground you've covered: walking into a wall, your feet go nowhere and make no sound.
      if (walking && walked.far > walked.time * QUIET_FEET) sound.step(player.pos, player.running ? 1 : 0);
      walked.far = walked.time = 0;
    }
    if (!player.grounded) fallV = Math.min(fallV, player.vy);
    else {
      // A hop lands at about 6 m/s, a drop from the loft at 10.
      if (fallV < -4) sound.land(player.pos, Math.min(1, (-fallV - 4) / 7));
      fallV = 0;
    }
  }

  /** Where you are: to everyone else a few times a second, and to come back to every second. */
  function tellWhereYouAre({ now }: Frame) {
    const { player, net } = ctx;
    const moved = Math.abs(player.pos.x - lastSent.x) + Math.abs(player.pos.y - lastSent.y) + Math.abs(player.pos.z - lastSent.z) > 0.01 || Math.abs(player.facing - lastSent.rotY) > 0.02;
    if ((moved || player.moving !== lastSent.moving) && now - lastSent.at > 66) {
      lastSent = { x: player.pos.x, y: player.pos.y, z: player.pos.z, rotY: player.facing, moving: player.moving, at: now };
      net.send({ t: 'move', x: player.pos.x, y: player.pos.y, z: player.pos.z, rotY: player.facing, moving: player.moving });
    }
    // Where you are, to come back to next time.
    if (now - spotSavedAt > 1000) {
      spotSavedAt = now;
      parts.place.saveSpot();
    }
  }

  /** The building and what's in it: its doors, its floors, the smoke and the confetti. */
  function updateWorld({ dt, t }: Frame) {
    const { player, office, camera } = ctx;
    const { remotes } = parts.peers;
    const { departures, sendoffs, arrivals } = parts.views;
    const court = parts.worlds.court();
    if (!core.upTop) {
      ctx.world().update(t, dt, [player.pos, ...[...remotes.values()].map((r) => r.person.root.position), ...departures.positions(), ...sendoffs.positions(), ...arrivals.positions(), ...(court?.positions() ?? [])]);
      if (ctx.inOffice()) {
        office.stack.update(dt, [{ x: player.pos.x, y: player.pos.y, z: player.pos.z, grip: ctx.view.grip() }, ...[...remotes.values()].map((r) => ({ x: r.person.root.position.x, y: r.person.root.position.y, z: r.person.root.position.z, grip: r.grip }))], camera.position);
      }
    }
    ctx.smoke.update(dt, camera);
    ctx.confetti.update(dt);
  }

  /** The sky, the weather and the light. */
  function updateSky({ dt, t }: Frame) {
    const { player, camera, sky, office, sound } = ctx;
    const { sun, hemi, ambient, scene, holiday } = parts.stage;
    // Out along the scenic loop, the haze thins (there's more out there to see), and the sun's shadows
    // come with you: otherwise they're only cast round the office.
    const away = !core.upTop && ctx.inOffice() ? Math.hypot(player.pos.x, player.pos.z) : 0;
    sky.open = THREE.MathUtils.smoothstep(away, 70, 160);
    if (away > 40) sun.target.position.set(Math.round(player.pos.x / 4) * 4, player.pos.y, Math.round(player.pos.z / 4) * 4);
    else sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
    sky.update(dt, t, camera);
    if (!core.upTop && ctx.inOffice()) office.scenic.cull(camera.position, office.night.street, (scene.fog as THREE.Fog).far);
    // A map of its own lights itself its own way (the castle's torchlit hall), after the sky's had its say.
    if (!core.upTop) ctx.world().mood?.({ sun, hemi, ambient, scene }, sky.daylight, t, camera.position);
    if (!core.upTop && ctx.inOffice()) holiday.update(t, sky.lampsOn, camera);
    sound.setWeather(sky.rain, 1 - sky.daylight);
  }

  /** Draws the frame, through whatever it's drawn through (a few drinks in, the drunk vision: see ctx.view). */
  function drawFrame(f: Frame) {
    ctx.view.draw(f, drawScene);
  }

  /** The scene, then your hands on top of it. */
  function drawScene() {
    const { player, hands, sky, camera, renderer } = ctx;
    const { effect, scene } = parts.stage;
    const firstPerson = player.view === 'first' && !player.overview;
    const unhide = firstBody?.hideExtras();
    effect.render(scene, camera);
    unhide?.();
    // Not while something has the screen to itself (the telescope, the boss's monitor or the arcade up close), where they'd cover it.
    if (firstPerson && !ctx.view.covered() && !ctx.activities.any('hidesHands')) {
      // Hands go on top of everything, so they never clip into a desk you walk up to. They have
      // lights of their own, turned down to match wherever you're standing.
      renderer.clearDepth();
      hands.setLight(sky.lightAt(camera.position));
      sky.shading(false);
      effect.render(hands.scene, hands.camera);
      sky.shading(true);
    }
  }
}

/**
 * The frame loop: each frame, every phase's ticks, in order (see TICK_PHASES, and installLoop). Its
 * clock starts now; hand what it returns to requestAnimationFrame to start it.
 *
 * It draws at the full frame rate only while something moves (see ctx.motion), and otherwise a few
 * times a second (IDLE_FPS); while the page is hidden it draws nothing, and picks up again once the
 * page is back. The sun's shadows are drawn once a frame while something moves (not on every render
 * call: the outlines draw the scene twice), and every few frames otherwise.
 */
export function frameLoop(ctx: Ctx, loading: { drew(): void }): (ts?: number) => void {
  const timer = new THREE.Timer();
  const shadows = ctx.renderer.shadowMap;
  shadows.autoUpdate = false;
  /** Frames drawn since something last moved. */
  let still = 0;
  /** The loop's been started (see main.ts). */
  let started = false;
  /** A frame's been asked for already, so coming back to the page doesn't start a second loop. */
  let asked = false;
  function frame(ts?: number) {
    started = true;
    asked = false;
    // Hidden: nothing to draw until the page is back (see visibilitychange below).
    if (document.hidden) return;
    ask();
    const moving = ctx.motion.moving();
    if (!ctx.motion.due(moving)) return;
    timer.update(ts);
    const delta = timer.getDelta();
    still = moving ? 0 : still + 1;
    shadows.needsUpdate = still % IDLE_SHADOW_EVERY === 0;
    ctx.ticks.run({ delta, dt: Math.min(delta, 0.1), t: timer.getElapsed(), now: performance.now() });
    loading.drew();
  }
  function ask() {
    if (asked) return;
    asked = true;
    requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !started) return;
    // Back: the world goes on from where it was (dt is capped), at the full rate for a moment.
    ctx.motion.wake();
    ask();
  });
  return frame;
}

/** While nothing moves, the sun's shadows are drawn every this many frames (a few times a second). */
const IDLE_SHADOW_EVERY = 3;

/**
 * What of the office's own keeps the full frame rate (see ctx.motion): you moving, the camera moving,
 * a trip to another floor, whatever you're in the middle of, the view shaking or taken over, the roof's
 * party, smoke and confetti, and your keys and mouse on the office itself (not typing in a window).
 */
function installMotion(ctx: Ctx, core: CoreState) {
  const { motion } = ctx;
  motion.add(() => ctx.player.moving || !ctx.player.grounded);
  motion.watch(() => [ctx.player.pos]);
  // The camera, wherever it's moved from (you, a ride, the telescope, a shake): where it is, which
  // way it looks, and how wide.
  const look = { x: 0, y: 0, z: 0 };
  const lens = { x: 0, y: 0, z: 0 };
  motion.watch(() => {
    const { camera } = ctx;
    const q = camera.quaternion;
    Object.assign(look, { x: q.x, y: q.y, z: q.z });
    Object.assign(lens, { x: q.w, y: camera.fov, z: camera.zoom });
    return [camera.position, look, lens];
  });
  motion.add(() => !!core.trip || core.thud > 0 || ctx.activities.busy() || ctx.view.covered());
  // Up on the roof, everything moves to the DJ's set.
  motion.add(() => core.upTop);
  motion.add(() => ctx.smoke.busy() || ctx.confetti.busy());
  // Typing in a window (a terminal, the chat) is no reason to draw the office faster.
  const typing = (e: Event) => e.target instanceof HTMLElement && (e.target.isContentEditable || !!e.target.closest('input, textarea, select'));
  const onKey = (e: Event) => {
    if (!typing(e)) motion.wake();
  };
  const onPointer = (e: Event) => {
    if (document.pointerLockElement || e.target === ctx.canvas) motion.wake();
  };
  for (const t of ['keydown', 'keyup']) window.addEventListener(t, onKey, { capture: true, passive: true });
  for (const t of ['pointerdown', 'pointerup', 'pointermove', 'wheel']) window.addEventListener(t, onPointer, { capture: true, passive: true });
  window.addEventListener('resize', () => motion.wake());
}
