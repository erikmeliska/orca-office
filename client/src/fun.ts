// "Fun" (M6, roadmap A11): agent-office's games and company — the chat, emotes, hanging pictures,
// the arcade cabinet, the gong, the hoop, the rooftop bar with its darts, axes and DJ. Off by default:
// they take room and attention from looking after the agents. Off, their props stay where they are
// but do nothing, and they're gone from the menu, ⌘K, the help and the keys. The dog stays.

/** What you can walk up to and use that is only fun. */
export const FUN_KINDS: ReadonlySet<string> = new Set(['cabinet', 'gong', 'ball', 'bar', 'dj', 'darts', 'axe', 'decor']);

/** The keys that only do fun things: chat (T, Enter), emotes (G, 1–6), hang a picture (F), drop the ball (Q). */
export const FUN_KEYS: ReadonlySet<string> = new Set(['KeyT', 'Enter', 'KeyG', 'KeyF', 'KeyQ', ...[1, 2, 3, 4, 5, 6].flatMap((n) => [`Digit${n}`, `Numpad${n}`])]);

/** The ☰ menu's fun actions, by id (see features/hud). */
export const FUN_ACTIONS: ReadonlySet<string> = new Set(['roof', 'decor']);

let on = false;
const listeners = new Set<(on: boolean) => void>();

export const funOn = () => on;

/** Turns the fun on or off; the page's `no-fun` class hides what's only fun (the chat box, the emote wheel). */
export function setFun(value: boolean) {
  on = value;
  if (typeof document !== 'undefined') document.body.classList.toggle('no-fun', !value);
  for (const l of listeners) l(value);
}

export function onFun(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether `kind` can be used now. */
export const usableKind = (kind: string) => on || !FUN_KINDS.has(kind);
