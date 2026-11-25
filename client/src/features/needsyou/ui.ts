import './ui.css';
import type { OrcaAnswer } from '@orca-office/shared/office/protocol/orca';
import { ORCA_LIMITS } from '@orca-office/shared/office/protocol/orca';
import { h } from '../../ui/dom';
import type { BannerAct, BannerText } from '../../waiting-all';

export interface BannerHooks {
  /** To that worker's desk. */
  go(id: string): void;
  /** Put away until someone else needs you. */
  hide(): void;
  /** Yes / Always / No on its permission prompt (M7 B1). */
  answer(workerId: string, choice: OrcaAnswer): void;
  /** A line of text into its terminal, then Enter (M7 B1). */
  reply(workerId: string, text: string): void;
  /** Show it in Orca (a chat agent: it has no terminal to answer in). */
  open(workerId: string): void;
}

/**
 * The banner under the top bar while a worker needs you: who, what it's asking and for how long, and
 * a click (or N) away from its desk. Under it, a way to answer without walking over (M7 B1): Yes /
 * Always / No on a permission prompt, a line for a question, or Open in Orca for a chat agent. The
 * edge of the screen flashes red when one starts asking.
 */
export class Banner {
  private readonly el: HTMLElement;
  private readonly go: HTMLButtonElement;
  private readonly act: HTMLElement;
  private readonly edge: HTMLElement;
  private shown: BannerText | null = null;
  /** Who the answer row is for (it's only rebuilt for someone else, so typing isn't lost). */
  private actKey = '';
  /** What was typed for whom, kept while the banner shows someone else for a moment. */
  private drafts = new Map<string, string>();

  constructor(
    private readonly hud: HTMLElement,
    private readonly hooks: BannerHooks,
  ) {
    this.go = h('button.needs-you-go', { type: 'button', onclick: () => this.shown && hooks.go(this.shown.id) });
    const x = h('button.needs-you-x', { type: 'button', 'aria-label': 'Hide', title: 'Hide until another worker needs you', onclick: () => hooks.hide() }, '✕');
    this.act = h('div.needs-you-act.hidden');
    this.el = h('div.needs-you.hidden', { role: 'status', 'aria-live': 'polite' }, h('div.needs-you-row', {}, this.go, x), this.act);
    this.edge = h('div.needs-you-flash', { 'aria-hidden': 'true' });
    this.edge.addEventListener('animationend', () => this.edge.classList.remove('on'));
    hud.append(this.el, this.edge);
    window.addEventListener('resize', () => this.place());
  }

  /** What it says now, or null to put it away. It's only redrawn when it would read differently, so a click never lands on a button that's just been swapped. */
  show(text: BannerText | null) {
    if (text?.key === this.shown?.key) return;
    this.shown = text;
    this.el.classList.toggle('hidden', !text);
    this.paintAct(text?.act ?? null);
    if (!text) return;
    this.go.title = `Go to ${text.title.replace(/ needs you$/, '')}'s desk (N)`;
    this.go.replaceChildren(
      h('span.needs-you-icon', { 'aria-hidden': 'true' }, '🙋'),
      h('span.needs-you-text', {}, h('strong', {}, text.title), text.detail ? h('span.needs-you-ask', {}, text.detail) : null),
      ...(text.more ? [h('span.needs-you-more', {}, text.more)] : []),
      h('span.key', {}, 'N'),
    );
    this.place();
  }

  /** The row to answer from (M7 B1), rebuilt only when it is for someone else or another kind of answer. */
  private paintAct(act: BannerAct) {
    const key = act ? `${act.workerId}|${act.kind}` : '';
    if (key === this.actKey) return;
    this.actKey = key;
    this.act.classList.toggle('hidden', !act);
    if (!act) return void this.act.replaceChildren();
    const btn = (label: string, title: string, onclick: () => void, cls = '') => h(`button.needs-you-btn${cls}`, { type: 'button', title, onclick }, label);
    if (act.kind === 'permission') {
      this.act.replaceChildren(
        h('span.needs-you-q', {}, 'Allow?'),
        btn('✓ Yes', `Allow it this once (presses its "Yes")`, () => this.hooks.answer(act.workerId, 'yes'), '.yes'),
        btn('✓✓ Always', `Allow it and don't ask again for this (its "don't ask again")`, () => this.hooks.answer(act.workerId, 'always')),
        btn('✕ No', 'Say no (Esc): it asks you what to do instead', () => this.hooks.answer(act.workerId, 'no'), '.no'),
      );
    } else if (act.kind === 'reply') {
      const input = h('input.needs-you-input', { type: 'text', maxlength: String(ORCA_LIMITS.prompt), placeholder: `Answer ${act.name}…`, 'aria-label': `Answer ${act.name}`, value: this.drafts.get(act.workerId) ?? '' });
      const send = () => {
        const text = input.value.trim();
        if (!text) return input.focus();
        this.hooks.reply(act.workerId, text);
        input.value = '';
        this.drafts.delete(act.workerId);
      };
      input.addEventListener('input', () => this.drafts.set(act.workerId, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          send();
        } else if (e.key === 'Escape') input.blur();
        e.stopPropagation();
      });
      this.act.replaceChildren(input, btn('Send ⏎', 'Type it into its terminal and press Enter', send, '.yes'));
    } else {
      this.act.replaceChildren(h('span.needs-you-q', {}, 'A chat: answer it in Orca'), btn('↗ Open in Orca', 'Show this chat in Orca', () => this.hooks.open(act.workerId)));
    }
  }

  /** A worker has just started asking: the edge of the screen pulses red a few times. */
  flash() {
    this.edge.classList.remove('on');
    // Read back, so taking the class off and putting it on again starts the animation over.
    void this.edge.offsetWidth;
    this.edge.classList.add('on');
  }

  /** Under the top bar, and under the dock too where it has wrapped down into the banner's way. */
  private place() {
    if (!this.shown) return;
    this.el.style.top = '';
    const dock = this.hud.querySelector('.dock')?.getBoundingClientRect();
    const me = this.el.getBoundingClientRect();
    if (dock && dock.left < me.right && dock.bottom > me.top - 8) this.el.style.top = `${Math.round(dock.bottom + 10)}px`;
  }
}
