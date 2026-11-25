import type { AudioCore } from '../../sound/core';

// The alarm for a worker that has stopped to ask you something.

/** The notes of the alarm, and of the reminder: [Hz, seconds in]. */
const ALARM: readonly (readonly [number, number])[] = [[784, 0], [1047, 0.13], [784, 0.42], [1175, 0.55]];
const AGAIN: readonly (readonly [number, number])[] = [[784, 0], [1047, 0.13]];

/**
 * Two rising pairs, brighter and louder than the ding for a worker that's done, so one is never taken
 * for the other. `again` is the reminder while it's still waiting: one pair, soft.
 */
export function needsYou(a: AudioCore, again = false) {
  a.unlock();
  const ctx = a.ctx;
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  a.count(again ? 'needs-you-again' : 'needs-you');
  const level = again ? 0.14 : 0.34;
  for (const [f, at] of again ? AGAIN : ALARM) {
    const t0 = ctx.currentTime + at;
    // A bell: the note, and a quieter one an octave up that dies away sooner.
    for (const [mult, amp, len] of [
      [1, level, 0.34],
      [2, level * 0.3, 0.16],
    ]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f * mult;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g).connect(a.alerts);
      o.start(t0);
      o.stop(t0 + len + 0.05);
    }
  }
}

/** What a worker is signalling (M7 B2), each with a sound of its own. */
export type Signal = 'permission' | 'question' | 'done' | 'failed';

/** A question: three soft notes going up, like a raised voice at the end (the permission alarm is the bell above). */
const QUESTION: readonly (readonly [number, number])[] = [[659, 0], [784, 0.12], [988, 0.24]];

/**
 * The sound of each signal: a permission prompt rings the alarm, a question asks in three rising
 * notes, done is the two-note ding, and a failure a low falling buzz, never taken for done.
 */
export function signal(a: AudioCore, kind: Signal) {
  if (kind === 'permission') return needsYou(a);
  a.unlock();
  const ctx = a.ctx;
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  a.count(`signal-${kind}`);
  const notes: readonly (readonly [number, number])[] = kind === 'question' ? QUESTION : kind === 'done' ? [[660, 0], [880, 0.12]] : [[392, 0], [311, 0.18], [233, 0.36]];
  for (const [f, at] of notes) {
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = kind === 'failed' ? 'sawtooth' : 'triangle';
    o.frequency.value = f;
    const amp = kind === 'failed' ? 0.12 : 0.28;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (kind === 'failed' ? 0.3 : 0.25));
    o.connect(g).connect(a.alerts);
    o.start(t0);
    o.stop(t0 + 0.35);
  }
}

/**
 * Said out loud (M7 B2, off unless Settings → Voice is on): who and what, never what it asks
 * ("blog-ai is waiting for permission"). The browser's own voice (Web Speech API); nothing is sent anywhere.
 */
export function speakSignal(name: string, kind: Signal) {
  if (typeof speechSynthesis === 'undefined') return;
  const what = kind === 'permission' ? 'is waiting for permission' : kind === 'question' ? 'has a question' : kind === 'done' ? 'is done' : 'failed';
  const u = new SpeechSynthesisUtterance(`${name.replace(/[-_]+/g, ' ')} ${what}`);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}
