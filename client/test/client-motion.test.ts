import { test } from 'vitest';
import assert from 'node:assert/strict';
import { IDLE_FPS, Motion, SETTLE_MS } from '../src/core/registry.js';

function clocked() {
  const clock = { now: 1000 };
  return { clock, motion: new Motion(() => clock.now) };
}

test('nothing registered and nothing woken: not moving', () => {
  const { motion } = clocked();
  assert.equal(motion.moving(), false);
});

test('wake keeps it moving for as long as asked, and a shorter wake never cuts a longer one short', () => {
  const { clock, motion } = clocked();
  motion.wake(500);
  motion.wake(100);
  clock.now += 499;
  assert.equal(motion.moving(), true);
  clock.now += 2;
  assert.equal(motion.moving(), false);
});

test('a provider keeps it moving while it says so, until it is taken back out', () => {
  const { motion } = clocked();
  let busy = true;
  const off = motion.add(() => busy);
  assert.equal(motion.moving(), true);
  busy = false;
  assert.equal(motion.moving(), false);
  busy = true;
  off();
  assert.equal(motion.moving(), false);
});

test('a watched point that moves keeps it moving for SETTLE_MS; one that holds still does not', () => {
  const { clock, motion } = clocked();
  const p = { x: 0, y: 0, z: 0 };
  motion.watch(() => [p]);
  // The first look has nothing to compare with: it counts as a change.
  assert.equal(motion.moving(), true);
  clock.now += SETTLE_MS + 1;
  assert.equal(motion.moving(), false);
  p.x = 0.00001;
  assert.equal(motion.moving(), false, 'a hundredth of a millimetre is holding still');
  p.z = 0.5;
  assert.equal(motion.moving(), true);
  clock.now += SETTLE_MS - 1;
  assert.equal(motion.moving(), true);
  clock.now += 2;
  assert.equal(motion.moving(), false);
});

test('one more or one fewer watched point is a change', () => {
  const { clock, motion } = clocked();
  const points = [{ x: 1, y: 2, z: 3 }];
  motion.watch(() => points);
  motion.moving();
  clock.now += SETTLE_MS + 1;
  assert.equal(motion.moving(), false);
  points.push({ x: 1, y: 2, z: 3 });
  assert.equal(motion.moving(), true);
});

test('due: every frame while moving, IDLE_FPS frames a second otherwise', () => {
  const { clock, motion } = clocked();
  let drawn = 0;
  // A second of 60 Hz frames, moving.
  for (let i = 0; i < 60; i++, clock.now += 1000 / 60) if (motion.due(true)) drawn++;
  assert.equal(drawn, 60);
  drawn = 0;
  for (let i = 0; i < 60; i++, clock.now += 1000 / 60) if (motion.due(false)) drawn++;
  assert.ok(Math.abs(drawn - IDLE_FPS) <= 1, `drew ${drawn} idle frames in a second`);
  // Something starts moving: drawn straight away, not on the idle beat.
  assert.equal(motion.due(true), true);
});
