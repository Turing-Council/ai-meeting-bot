import type { OggOpusWriter } from './ogg.js';
import { OPUS_SAMPLE_RATE, OPUS_SILENCE_FRAME, SAMPLES_PER_20MS, opusPacketSamples } from './opus.js';

const SAMPLES_PER_MS = OPUS_SAMPLE_RATE / 1000;

export interface TimelineTrackOptions {
  writer: OggOpusWriter;
  /** Wall-clock time (ms since epoch) that sample 0 of every track corresponds to. */
  sessionStartMs: number;
  now?: () => number;
  /**
   * Gaps shorter than this are treated as network jitter and not filled with silence.
   * Larger gaps (the speaker went quiet) are filled so the track stays aligned to the meeting clock.
   */
  jitterToleranceMs?: number;
}

/**
 * One speaker's audio, aligned to the meeting clock.
 *
 * Discord only sends packets while someone talks. To keep every speaker's track starting at
 * the meeting start and lined up with the others, gaps are filled with Opus silence frames
 * (3 bytes each, ~1 MB per hour of silence), so tracks can be mixed or transcribed with
 * correct timestamps and no re-encoding.
 */
export class TimelineTrack {
  private readonly writer: OggOpusWriter;
  private readonly sessionStartMs: number;
  private readonly now: () => number;
  private readonly toleranceSamples: number;
  private packetsReceived = 0;

  constructor(options: TimelineTrackOptions) {
    this.writer = options.writer;
    this.sessionStartMs = options.sessionStartMs;
    this.now = options.now ?? Date.now;
    this.toleranceSamples = (options.jitterToleranceMs ?? 100) * SAMPLES_PER_MS;
  }

  get samplesWritten(): number {
    return this.writer.samplesWritten;
  }

  get durationMs(): number {
    return this.samplesWritten / SAMPLES_PER_MS;
  }

  get receivedPackets(): number {
    return this.packetsReceived;
  }

  /** Appends a received Opus packet, inserting silence first if the speaker was quiet. */
  pushPacket(packet: Uint8Array): void {
    const samples = opusPacketSamples(packet);
    if (samples === 0) return;
    this.packetsReceived++;

    // A packet arriving now covers roughly the last `samples` of audio before now.
    const expectedEnd = this.elapsedSamples(this.now());
    this.fillSilenceUntil(expectedEnd - samples, this.toleranceSamples);
    this.writer.writePacket(packet, samples);
  }

  /** Pads the track with silence up to `atMs` (wall clock), e.g. so all tracks end together. */
  padTo(atMs: number): void {
    this.fillSilenceUntil(this.elapsedSamples(atMs), 0);
  }

  flush(): void {
    this.writer.flush();
  }

  end(): void {
    this.writer.end();
  }

  private elapsedSamples(atMs: number): number {
    return Math.max(0, Math.round((atMs - this.sessionStartMs) * SAMPLES_PER_MS));
  }

  private fillSilenceUntil(targetSamples: number, toleranceSamples: number): void {
    const gap = targetSamples - this.writer.samplesWritten;
    if (gap <= toleranceSamples) return;
    const frames = Math.floor(gap / SAMPLES_PER_20MS);
    for (let i = 0; i < frames; i++) this.writer.writePacket(OPUS_SILENCE_FRAME, SAMPLES_PER_20MS);
  }
}
