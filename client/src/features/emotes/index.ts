/** Emotes: G opens the wheel (hold it and point, or tap it and click), 1 to 6 play one straight away. */
import { EMOTES, EMOTE_BY_ID, EmoteBucket, type EmoteId } from '@orca-office/shared/office/emotes';
import type { Ctx } from '../../core/context';
import { $, h, toast } from '../../ui/dom';
import { EmoteWheel } from './ui';
import { funOn } from '../../fun';
import type { Person } from '../../world/character';

export interface EmotesDeps {
  /** Someone else on your floor, as you see them. */
  personOf(id: string): Person | undefined;
}

export function installEmotes(ctx: Ctx, deps: EmotesDeps) {
  /** The same limit the server keeps, so an emote you see yourself do is one everyone else sees too. */
  const emoteLimit = new EmoteBucket();
  let emoteWarnedAt = 0;
  /** Plays an emote on your character and your hands, and shows it to everyone else on the floor. */
  function emote(id: EmoteId) {
    const now = performance.now();
    if (!emoteLimit.take(now)) {
      if (now - emoteWarnedAt > 3000) {
        emoteWarnedAt = now;
        toast('Easy there, one emote at a time', 'warn');
      }
      return;
    }
    ctx.me.emote(id);
    ctx.hands.emote(id);
    playing(id);
    if (ctx.player.view === 'first') popEmoji(id);
    ctx.net.send({ t: 'emote', emote: id });
  }
  ctx.messages.on('peer.emote', (msg) => {
    const who = deps.personOf(msg.id);
    if (!who) return;
    who.emote(msg.emote);
    playing(msg.emote);
  });
  /** An emote's under way: the full frame rate till it's played out (see ctx.motion). */
  function playing(id: EmoteId) {
    ctx.motion.wake((EMOTE_BY_ID.get(id)?.seconds ?? 2) * 1000 + 500);
  }
  const emoteWheel = new EmoteWheel(emote, (open) => (ctx.player.mouseLook = !open));
  $('hud').append(emoteWheel.el);
  // A window opening puts the wheel away.
  ctx.windowOpened.add(() => emoteWheel.close());

  /** In first person you can't see the emoji over your head, so it pops up on the screen instead. */
  function popEmoji(id: EmoteId) {
    const e = EMOTE_BY_ID.get(id)!;
    document.querySelector('.emote-pop')?.remove();
    const el = h('div.emote-pop', { style: `--secs:${e.seconds}s`, 'aria-hidden': 'true' }, e.emoji);
    el.addEventListener('animationend', () => el.remove());
    $('hud').append(el);
  }

  /** G opens the emote wheel (hold it and point, or tap it and click); 1–6 play one straight away. */
  function emoteKey(e: KeyboardEvent): boolean {
    // With the fun off, G is the Command Center's (M7 B3).
    if (e.code === 'KeyG' && funOn()) {
      if (!e.repeat) emoteWheel.press();
      return true;
    }
    if (e.code === 'Escape' && emoteWheel.isOpen) {
      emoteWheel.close();
      return true;
    }
    const n = /^(?:Digit|Numpad)([1-6])$/.exec(e.code);
    if (!n) return false;
    emoteWheel.close();
    emote(EMOTES[Number(n[1]) - 1].id);
    return true;
  }

  ctx.keys.add('emote', emoteKey);

  return { emote, emoteWheel };
}
