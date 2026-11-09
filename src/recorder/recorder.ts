import { createWriteStream, type WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { EndBehaviorType, type AudioReceiveStream, type VoiceReceiver } from '@discordjs/voice';
import type { Logger } from '../logger.js';
import { OggOpusWriter } from './ogg.js';
import { TimelineTrack } from './track.js';

/** How often buffered audio is pushed to disk even when pages are not full. */
const FLUSH_INTERVAL_MS = 2000;

export interface RecorderOptions {
  receiver: VoiceReceiver;
  /** Session directory; tracks are written to `<dir>/tracks/<userId>.ogg`. */
  sessionDir: string;
  sessionStartMs: number;
  logger: Logger;
  /** Return false to skip a user (e.g. other bots). */
  shouldRecord?: (userId: string) => boolean;
  /** Called the first time a user's audio arrives. */
  onNewSpeaker?: (userId: string, relativeFile: string) => void;
  /** Called with every recorded Opus packet and its arrival time (wall clock, ms). Not called while paused. */
  onPacket?: (userId: string, packet: Buffer, atMs: number) => void;
  now?: () => number;
}

interface SpeakerTrack {
  track: TimelineTrack;
  file: WriteStream;
  relativeFile: string;
}

/**
 * Records every speaker in a voice connection to their own time-aligned Ogg Opus file.
 * Subscriptions stay open for the whole meeting; if one breaks (e.g. a decryption error
 * during a DAVE key change) it is re-created the next time that user speaks.
 */
export class MeetingRecorder {
  private readonly receiver: VoiceReceiver;
  private readonly sessionDir: string;
  private readonly sessionStartMs: number;
  private readonly logger: Logger;
  private readonly shouldRecord: (userId: string) => boolean;
  private readonly onNewSpeaker: ((userId: string, relativeFile: string) => void) | undefined;
  private readonly onPacket: ((userId: string, packet: Buffer, atMs: number) => void) | undefined;
  private readonly now: () => number;

  private readonly speakers = new Map<string, SpeakerTrack>();
  private readonly streams = new Map<string, AudioReceiveStream>();
  private flushTimer: NodeJS.Timeout | undefined;
  private paused = false;
  private stopped = false;

  constructor(options: RecorderOptions) {
    this.receiver = options.receiver;
    this.sessionDir = options.sessionDir;
    this.sessionStartMs = options.sessionStartMs;
    this.logger = options.logger;
    this.shouldRecord = options.shouldRecord ?? (() => true);
    this.onNewSpeaker = options.onNewSpeaker;
    this.onPacket = options.onPacket;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.receiver.speaking.on('start', this.handleSpeakingStart);
    // Users already talking when we joined won't fire 'start' until their next pause.
    for (const userId of this.receiver.speaking.users.keys()) this.handleSpeakingStart(userId);
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
  }

  /** While paused, incoming audio is dropped; the gap becomes silence in every track. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get speakerIds(): string[] {
    return [...this.speakers.keys()];
  }

  /** Stops receiving, pads all tracks to `endMs` and closes the files. Safe to call twice. */
  async stop(endMs: number = this.now()): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.receiver.speaking.off('start', this.handleSpeakingStart);
    if (this.flushTimer) clearInterval(this.flushTimer);

    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();

    await Promise.all(
      [...this.speakers.entries()].map(async ([userId, speaker]) => {
        try {
          speaker.track.padTo(endMs);
          speaker.track.end();
        } catch (error) {
          this.logger.error('Failed to finalize track', { userId, error });
        }
        speaker.file.end();
        await finished(speaker.file).catch((error: unknown) =>
          this.logger.error('Failed to close track file', { userId, error }),
        );
      }),
    );
  }

  private readonly handleSpeakingStart = (userId: string): void => {
    if (this.stopped || this.streams.has(userId) || !this.shouldRecord(userId)) return;

    const stream = this.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    this.streams.set(userId, stream);
    const speaker = this.getOrCreateSpeaker(userId);

    stream.on('data', (packet: Buffer) => {
      if (this.paused || this.stopped) return;
      try {
        speaker.track.pushPacket(packet);
      } catch (error) {
        this.logger.error('Failed to write audio packet', { userId, error });
      }
      // After the write: a failure in live transcription must never cost the recording.
      try {
        this.onPacket?.(userId, packet, this.now());
      } catch (error) {
        this.logger.error('Live packet handler failed', { userId, error });
      }
    });
    stream.once('error', (error) => this.logger.warn('Audio stream error; will resubscribe', { userId, error }));
    stream.once('close', () => {
      if (this.streams.get(userId) === stream) this.streams.delete(userId);
    });
  };

  private getOrCreateSpeaker(userId: string): SpeakerTrack {
    const existing = this.speakers.get(userId);
    if (existing) return existing;

    const relativeFile = path.posix.join('tracks', `${userId}.ogg`);
    const file = createWriteStream(path.join(this.sessionDir, relativeFile), { flags: 'w' });
    file.on('error', (error) => this.logger.error('Track file error', { userId, error }));
    const writer = new OggOpusWriter({ sink: (page) => file.write(page) });
    const track = new TimelineTrack({ writer, sessionStartMs: this.sessionStartMs, now: this.now });

    const speaker = { track, file, relativeFile };
    this.speakers.set(userId, speaker);
    this.logger.info('New speaker', { userId });
    this.onNewSpeaker?.(userId, relativeFile);
    return speaker;
  }

  private flushAll(): void {
    for (const [userId, speaker] of this.speakers) {
      try {
        speaker.track.flush();
      } catch (error) {
        this.logger.error('Failed to flush track', { userId, error });
      }
    }
  }
}
