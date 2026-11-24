import type { AudioCore } from './core';

/**
 * Your music volume, apart from the office sounds': the bus the rooftop DJ plays into. In agent-office
 * this was the jukebox's (features/jukebox/sound.ts), which orca-office dropped (design.md #16).
 */
export class MusicBus {
  bus!: GainNode;
  private volume = 0.5;
  private muted = false;

  constructor(private readonly a: AudioCore) {}

  /** Once there's audio. It skips the master (it has its own volume). */
  connect(ctx: AudioContext) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(ctx.destination);
  }

  setVolume(volume: number, muted: boolean) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.muted = muted;
    this.apply();
  }

  apply() {
    if (!this.a.ctx) return;
    this.bus.gain.setTargetAtTime(this.muted ? 0 : this.volume * this.volume, this.a.ctx.currentTime, 0.04);
  }
}
