import { OPUS_SAMPLE_RATE, OPUS_SILENCE_FRAME, opusPacketSamples } from '../recorder/opus.js';

const SAMPLES_PER_MS = OPUS_SAMPLE_RATE / 1000;

/** One stretch of a single person's speech. Times are ms from the meeting start. */
export interface Utterance {
  userId: string;
  startMs: number;
  endMs: number;
  packets: Buffer[];
}

export interface SegmenterOptions {
  /** A pause this long in a speaker's packets ends the utterance. */
  silenceMs: number;
  /** Longer monologues are cut here. */
  maxMs: number;
  /** Shorter blips (clicks, breaths) are dropped. */
  minMs: number;
  onUtterance: (utterance: Utterance) => void;
}

interface Open {
  startMs: number;
  samples: number;
  packets: Buffer[];
  timer: NodeJS.Timeout | undefined;
}

/**
 * Splits each speaker's packets into utterances. Discord only sends audio while someone talks,
 * so a gap in the packets is a pause: no voice-activity detection is needed.
 *
 * shortcut: a monologue is cut at maxMs even if that lands mid-word; upgrade by cutting at the
 * quietest (smallest) packets near the limit if split words show up in transcripts.
 */
export class UtteranceSegmenter {
  private readonly open = new Map<string, Open>();

  constructor(private readonly options: SegmenterOptions) {}

  /** `atMs` is when the packet arrived, relative to the meeting start. */
  push(userId: string, packet: Buffer, atMs: number): void {
    // Discord ends each burst of speech with a few of these.
    if (packet.equals(OPUS_SILENCE_FRAME)) return;
    const samples = opusPacketSamples(packet);
    if (samples === 0) return;

    let current = this.open.get(userId);
    if (current && current.samples + samples > this.options.maxMs * SAMPLES_PER_MS) {
      this.close(userId);
      current = undefined;
    }
    if (!current) {
      // A packet arriving now covers the audio just before it.
      current = { startMs: Math.max(0, atMs - samples / SAMPLES_PER_MS), samples: 0, packets: [], timer: undefined };
      this.open.set(userId, current);
    }
    current.packets.push(packet);
    current.samples += samples;
    clearTimeout(current.timer);
    current.timer = setTimeout(() => this.close(userId), this.options.silenceMs);
  }

  /** Closes everything still open (the meeting ended). */
  flush(): void {
    for (const userId of [...this.open.keys()]) this.close(userId);
  }

  private close(userId: string): void {
    const current = this.open.get(userId);
    if (!current) return;
    clearTimeout(current.timer);
    this.open.delete(userId);
    const durationMs = current.samples / SAMPLES_PER_MS;
    if (durationMs < this.options.minMs) return;
    this.options.onUtterance({
      userId,
      startMs: current.startMs,
      endMs: current.startMs + durationMs,
      packets: current.packets,
    });
  }
}
