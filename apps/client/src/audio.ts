/**
 * Procedural audio.
 *
 * Every sound is synthesised with the Web Audio API, so the project ships with
 * no third-party audio assets and needs no licence attribution (see
 * docs/ASSETS_AND_LICENSES.md). The game is fully playable with audio muted or
 * unavailable — all failure paths are silent.
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.6;
  private muted = false;
  private noiseBuffer: AudioBuffer | null = null;

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  /** Must be called from a user gesture on most browsers. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      if (!this.context) {
        this.context = new Ctor();
        this.master = this.context.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume;
        this.master.connect(this.context.destination);
        this.noiseBuffer = this.makeNoise(this.context);
      }
      if (this.context.state === 'suspended') void this.context.resume();
    } catch {
      this.context = null;
      this.master = null;
    }
  }

  dispose(): void {
    try {
      void this.context?.close();
    } catch {
      /* ignore */
    }
    this.context = null;
    this.master = null;
  }

  private makeNoise(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * 0.5);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private tone(
    frequency: number,
    duration: number,
    options: { type?: OscillatorType; gain?: number; sweepTo?: number; delay?: number } = {},
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const start = context.currentTime + (options.delay ?? 0);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = options.type ?? 'square';
    oscillator.frequency.setValueAtTime(frequency, start);
    if (options.sweepTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, options.sweepTo), start + duration);
    }
    const peak = options.gain ?? 0.25;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noise(duration: number, options: { gain?: number; frequency?: number; q?: number; delay?: number } = {}): void {
    const context = this.context;
    const master = this.master;
    const buffer = this.noiseBuffer;
    if (!context || !master || !buffer) return;
    const start = context.currentTime + (options.delay ?? 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = options.frequency ?? 800;
    filter.Q.value = options.q ?? 0.8;
    const gain = context.createGain();
    const peak = options.gain ?? 0.2;
    gain.gain.setValueAtTime(peak, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter).connect(gain).connect(master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  punch(): void {
    this.noise(0.12, { gain: 0.22, frequency: 420, q: 1.1 });
    this.tone(150, 0.09, { type: 'triangle', gain: 0.16, sweepTo: 80 });
  }

  hit(): void {
    this.noise(0.16, { gain: 0.26, frequency: 260, q: 0.9 });
    this.tone(90, 0.16, { type: 'sawtooth', gain: 0.18, sweepTo: 55 });
  }

  gravityShot(): void {
    this.tone(320, 0.28, { type: 'sine', gain: 0.18, sweepTo: 720 });
  }

  shockwave(): void {
    this.tone(120, 0.5, { type: 'sawtooth', gain: 0.22, sweepTo: 40 });
    this.noise(0.4, { gain: 0.18, frequency: 320, q: 0.6 });
  }

  platformHit(): void {
    this.noise(0.22, { gain: 0.24, frequency: 180, q: 0.7 });
    this.tone(70, 0.22, { type: 'square', gain: 0.14, sweepTo: 45 });
  }

  collapse(): void {
    this.noise(1.1, { gain: 0.3, frequency: 140, q: 0.5 });
    this.tone(60, 1.0, { type: 'sawtooth', gain: 0.18, sweepTo: 30 });
  }

  jump(): void {
    this.tone(420, 0.1, { type: 'triangle', gain: 0.12, sweepTo: 620 });
  }

  land(): void {
    this.noise(0.09, { gain: 0.14, frequency: 220, q: 0.8 });
  }

  dodge(): void {
    this.noise(0.18, { gain: 0.16, frequency: 1600, q: 0.5 });
  }

  respawn(): void {
    this.tone(310, 0.35, { type: 'sine', gain: 0.16, sweepTo: 620 });
    this.tone(465, 0.3, { type: 'sine', gain: 0.12, sweepTo: 930, delay: 0.05 });
  }

  eliminated(): void {
    this.tone(220, 0.7, { type: 'sawtooth', gain: 0.2, sweepTo: 60 });
  }

  denied(): void {
    this.tone(180, 0.12, { type: 'square', gain: 0.1, sweepTo: 120 });
  }

  countdownBeep(final: boolean): void {
    this.tone(final ? 880 : 520, final ? 0.4 : 0.14, { type: 'sine', gain: 0.2 });
  }

  uiClick(): void {
    this.tone(600, 0.06, { type: 'triangle', gain: 0.1 });
  }
}
