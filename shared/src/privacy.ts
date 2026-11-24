/**
 * Privacy rules for agent text (design #20, issue #6).
 *
 * Agent messages, previews and bot chat texts are private. The bridge may show
 * a short bubble built with `toBubble`, but must never persist or log the
 * original. `redactForLog` strips every field that can carry such text before
 * anything is written to a log.
 */

/** Maximum length of agent text shown in a speech bubble. */
export const BUBBLE_MAX_CHARS = 120;

/**
 * Fields that can carry conversation text, prompts or tool payloads. Agent
 * `title`s are often generated from the first prompt, so they count too.
 */
export const PRIVATE_FIELDS: ReadonlySet<string> = new Set([
  'lastAssistantMessage',
  'lastMessage',
  'preview',
  'prompt',
  'message',
  'text',
  'body',
  'input',
  'output',
  'lines',
  'content',
  'subject',
  'title',
  'lastAsked',
  'lastSaid',
  'objective',
]);

/** Turns private agent text into a short, single-line bubble for display only. */
export function toBubble(text: string | null | undefined, max = BUBBLE_MAX_CHARS): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine === '') return null;
  const chars = Array.from(oneLine);
  if (chars.length <= max) return oneLine;
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** Deep copy of `value` with every private field replaced by its length. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(key) && v !== null && v !== undefined) {
      out[key] = `[redacted ${typeof v === 'string' ? v.length + ' chars' : typeof v}]`;
    } else {
      out[key] = redactForLog(v, depth + 1);
    }
  }
  return out;
}
