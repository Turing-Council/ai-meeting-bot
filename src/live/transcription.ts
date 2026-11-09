import type { Logger } from '../logger.js';
import type { SttProvider } from '../stt/index.js';
import type { TranscriptSegment } from '../transcript/transcript.js';
import { encodeUtterance } from './encode.js';
import { UtteranceSegmenter, type Utterance } from './segmenter.js';

/** Shorter speech is noise. */
const MIN_UTTERANCE_MS = 400;
/** Warn when the server is this far behind the speakers. */
const LAG_WARN_MS = 15_000;
const PROMPT_MAX_CHARS = 500;

export interface LiveTranscriptionOptions {
  stt: SttProvider;
  silenceMs: number;
  maxUtteranceMs: number;
  concurrency: number;
  /** Utterances that waited longer than this are skipped: the post-meeting transcript still has them. */
  maxAgeMs?: number;
  /** Vocabulary hint for the speech model (meeting title, participants). */
  prompt: () => string;
  speakerName: (userId: string) => string;
  onLine: (line: TranscriptSegment) => void;
  logger: Logger;
  now?: () => number;
}

interface Queued {
  utterance: Utterance;
  queuedAt: number;
}

/**
 * Turns the recorder's packets into transcript lines while the meeting runs: each utterance is
 * sent to the STT server as soon as the speaker pauses. Failures are logged and skipped, never
 * thrown into the recording. Lines arrive in completion order, which can differ slightly from
 * speaking order when two speakers overlap.
 */
export class LiveTranscription {
  private readonly segmenter: UtteranceSegmenter;
  private readonly queue: Queued[] = [];
  private readonly lastText = new Map<string, string>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private running = 0;
  private closed = false;
  private idle: (() => void) | undefined;

  constructor(private readonly options: LiveTranscriptionOptions) {
    this.maxAgeMs = options.maxAgeMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.segmenter = new UtteranceSegmenter({
      silenceMs: options.silenceMs,
      maxMs: options.maxUtteranceMs,
      minMs: MIN_UTTERANCE_MS,
      onUtterance: (utterance) => this.enqueue(utterance),
    });
  }

  /** `atMs` is relative to the meeting start. */
  push(userId: string, packet: Buffer, atMs: number): void {
    if (!this.closed) this.segmenter.push(userId, packet, atMs);
  }

  /** Sends what is still open, waits up to `drainMs` for the results, then drops the rest and goes quiet. */
  async stop(drainMs: number): Promise<void> {
    if (this.closed) return;
    this.segmenter.flush();
    if (this.queue.length > 0 || this.running > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        new Promise<void>((resolve) => (this.idle = resolve)),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, drainMs))),
      ]);
      clearTimeout(timer);
    }
    this.closed = true;
    this.queue.length = 0;
  }

  private enqueue(utterance: Utterance): void {
    if (this.closed) return;
    this.queue.push({ utterance, queuedAt: this.now() });
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.running < this.options.concurrency && this.queue.length > 0) {
      const { utterance, queuedAt } = this.queue.shift()!;
      const waitedMs = this.now() - queuedAt;
      if (waitedMs > this.maxAgeMs) {
        this.options.logger.warn('Live transcription is behind: skipped an utterance', { userId: utterance.userId, waitedMs });
        continue;
      }
      if (waitedMs > LAG_WARN_MS) this.options.logger.warn('Live transcription is lagging', { waitedMs });
      this.running++;
      void this.transcribe(utterance).finally(() => {
        this.running--;
        this.pump();
        if (this.running === 0 && this.queue.length === 0) this.idle?.();
      });
    }
    if (this.running === 0 && this.queue.length === 0) this.idle?.();
  }

  private async transcribe(utterance: Utterance): Promise<void> {
    const { userId, startMs, endMs } = utterance;
    try {
      const before = this.lastText.get(userId);
      const prompt = `${this.options.prompt()}${before ? ` Before: ${before}` : ''}`.slice(0, PROMPT_MAX_CHARS);
      const segments = await this.options.stt.transcribe({
        file: `${userId}-${Math.round(startMs)}.ogg`,
        audio: new Blob([new Uint8Array(encodeUtterance(utterance.packets))], { type: 'audio/ogg' }),
        durationMs: endMs - startMs,
        prompt,
      });
      const text = segments.map((s) => s.text.trim()).join(' ').trim();
      if (!text || this.closed) return;
      this.lastText.set(userId, text);
      this.options.onLine({ speakerId: userId, speaker: this.options.speakerName(userId), startMs, endMs, text });
    } catch (error) {
      this.options.logger.warn('Live transcription request failed', { userId, error });
    }
  }
}
