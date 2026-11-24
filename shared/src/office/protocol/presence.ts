// People in the office: where they are and what they do, chat and the welcome.

import type { Look } from '../avatar.js';
import type { BarGame } from '../bargames.js';
import type { EmoteId } from '../emotes.js';
import type { DrinkId } from '../rooftop.js';
import type { Me } from './accounts.js';
import type { FloorInfo, FloorView, ProjectsDirState } from './floors.js';
import type { LeaveOnMergeState, MachineState, MapState, NotifyState, PromptsState, SkyState, ThemeState, UpgradeState } from './settings.js';
import type { PlanLimits, UsageState } from './usage.js';

/** The issue on a card in someone's hands (see client/src/world/held-card.ts; nothing carries one in orca-office yet). */
export interface CarriedIssue {
  issue: number;
  title: string;
}

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  /** Skin tone and hair, picked on the character select screen. */
  look: Look;
  x: number;
  y: number;
  z: number;
  rotY: number;
  moving: boolean;
  /** On a smoke break, cigarette in hand. */
  smoking?: boolean;
  /** At the rooftop bar's dart board or axe lane, a dart or an axe in hand. */
  throwing?: BarGame;
  /** Sitting down: the place they're in (see seatAt in layout), like "couch:1". */
  seat?: string;
  /** A drink from the rooftop bar in their hand. */
  drink?: DrinkId;
  /** Signed in with their own account, so `name` is theirs and nobody else can take it. */
  account?: boolean;
  /** The floor they're on (see FloorInfo); none while the building has no floors yet. */
  floor?: string;
  /** What they have open, in their own words: "in Pixel's terminal", "reading PR #12". */
  doing?: string;
  /** Reading something off the bookshelf: an open book in their hands, its pages turning. */
  reading?: boolean;
  /** On the 2D view (/lite: a phone, say, or a slow computer): in the office, but not standing anywhere in it. */
  lite?: boolean;
}

export interface ChatLine {
  from: string;
  name: string;
  color: string;
  text: string;
  at: number;
  /** Said by someone signed in with their own account. */
  account?: boolean;
}

/** A line of a worker's terminal that matched a search. */
export interface TerminalHit {
  workerId: string;
  /** The line, cut down around the match. */
  text: string;
  /** Where it is: its row in the worker's terminal, and how many rows that terminal had. */
  row: number;
  rows: number;
}

/** What GET /api/search answers: matching chat and terminal lines, newest first. */
export interface SearchResults {
  q: string;
  chat: ChatLine[];
  terminals: TerminalHit[];
  /** More lines matched than these. */
  more: boolean;
}

export type PresenceClientMsg =
  | { t: 'move'; x: number; y: number; z: number; rotY: number; moving: boolean }
  /**
   * You reached out to use something; everyone else sees your character's arm do it. With `smoke`,
   * you lit a cigarette (or put it out) on the balcony instead; with `drink`, you took a drink from the rooftop bar (or finished it,
   * null); with `throwing`, you stepped up to the dart board or the axe lane up there (or back, null).
   */
  | { t: 'act'; smoke?: boolean; drink?: DrinkId | null; throwing?: BarGame | null }
  /** You sat down in a place on a couch, a beanbag, a chair or the bench (see seatAt in layout), or got up again (no seat). */
  | { t: 'sit'; seat?: string }
  /** An emote (hold G, or 1–6): everyone else on your floor sees your character do it. Rate limited, see EmoteBucket. */
  | { t: 'emote'; emote: EmoteId }
  | { t: 'profile'; name: string; color: string; look: Look }
  /** What you have open now (see PeerInfo.doing and PeerInfo.reading); none when you're back in the office. */
  | { t: 'doing'; what?: string; reading?: boolean }
  | { t: 'chat'; text: string }
  | { t: 'ping'; at: number };

export type PresenceServerMsg =
  | ({
      t: 'welcome';
      you: string;
      peers: PeerInfo[];
      /** Every floor of the building, for the elevator. */
      floors: FloorInfo[];
      /** Where new projects are cloned to, on the office's machine. */
      projectsDir: ProjectsDirState;
      chat: ChatLine[];
      /** Whether teammates can be invited from the office (see TeamState). */
      invites: boolean;
      /** The running server's version; a change after a reconnect means the office was upgraded. */
      version: string;
      upgrade: UpgradeState;
      usage: UsageState;
      limits: PlanLimits;
      me: Me;
      notify: NotifyState;
      machine: MachineState;
      /** Outside the windows: the same on every floor. */
      sky: SkyState;
      /** Halloween or Christmas decorations, all over the building, or none. */
      theme: ThemeState;
      /** What the building looks like inside. */
      map: MapState;
      /** The office's prompts and the worker everyone starts on. */
      prompts: PromptsState;
      leaveOnMerge: LeaveOnMergeState;
    } & FloorView)
  | { t: 'peer.join'; peer: PeerInfo }
  | { t: 'peer.update'; peer: PeerInfo }
  | { t: 'peer.move'; id: string; x: number; y: number; z: number; rotY: number; moving: boolean }
  | { t: 'peer.leave'; id: string }
  | { t: 'peer.act'; id: string; smoke?: boolean; drink?: DrinkId | null; throwing?: BarGame | null }
  | { t: 'peer.emote'; id: string; emote: EmoteId }
  | ({ t: 'chat' } & ChatLine)
  | { t: 'toast'; text: string; level: 'info' | 'warn' | 'error' }
  /** Sent to whoever tried to sit where someone on the floor already is. */
  | { t: 'sit.refused'; seat: string; by: string }
  /** `now` is the office's clock as it answered, which the jukebox keeps time by. */
  | { t: 'pong'; at: number; now: number };
