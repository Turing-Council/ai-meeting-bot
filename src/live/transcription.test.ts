import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../logger.js';
import type { SttProvider, SttSegment, TranscribeRequest } from '../stt/index.js';
import type { TranscriptSegment } from '../transcript/transcript.js';
import { LiveTranscription } from './transcription.js';

const voice = Buffer.from([0xfc, 1, 1]);

/** An STT stand-in whose requests finish when the test says so. */
class FakeStt implements SttProvider {
  readonly name = 'fake';
  requests: { request: TranscribeRequest; done: (text: string | Error) => void }[] = [];
  transcribe(request: TranscribeRequest): Promise<SttSegment[]> {
    return new Promise((resolve, reject) => {
      this.requests.push({
        request,
        done: (result) =>
          typeof result === 'string' ? resolve([{ startMs: 0, endMs: request.durationMs, text: result }]) : reject(result),
      });
    });
  }
}

describe('LiveTranscription', () => {
  let stt: FakeStt;
  let lines: TranscriptSegment[];
  let clock: number;

  beforeEach(() => {
    vi.useFakeTimers();
    stt = new FakeStt();
    lines = [];
    clock = 0;
  });
  afterEach(() => vi.useRealTimers());

  const make = (extra: { concurrency?: number; maxAgeMs?: number } = {}) =>
    new LiveTranscription({
      stt,
      silenceMs: 800,
      maxUtteranceMs: 20_000,
      concurrency: extra.concurrency ?? 2,
      maxAgeMs: extra.maxAgeMs ?? 30_000,
      prompt: () => 'Meeting: Sync.',
      speakerName: (id) => id.toUpperCase(),
      onLine: (line) => lines.push(line),
      logger: silentLogger,
      now: () => clock,
    });
  /** 500 ms of speech starting at `atMs`, then the pause that closes the utterance. */
  const say = async (live: LiveTranscription, userId: string, atMs: number) => {
    for (let i = 0; i < 25; i++) live.push(userId, voice, atMs + i * 20);
    await vi.advanceTimersByTimeAsync(800);
  };

  it('sends an utterance as in-memory Ogg and publishes the text as a line', async () => {
    const live = make();
    await say(live, 'alice', 5_000);
    expect(stt.requests).toHaveLength(1);
    expect(stt.requests[0]!.request.audio).toBeInstanceOf(Blob);
    expect(stt.requests[0]!.request.durationMs).toBe(500);
    stt.requests[0]!.done(' Hello there. ');
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual([{ speakerId: 'alice', speaker: 'ALICE', startMs: 4_980, endMs: 5_480, text: 'Hello there.' }]);
  });

  it('gives the model the speaker\'s previous line as context', async () => {
    const live = make();
    await say(live, 'alice', 0);
    stt.requests[0]!.done('We should ship on Friday.');
    await vi.advanceTimersByTimeAsync(0);
    await say(live, 'alice', 3_000);
    expect(stt.requests[1]!.request.prompt).toBe('Meeting: Sync. Before: We should ship on Friday.');
  });

  it('runs at most `concurrency` requests at once', async () => {
    const live = make({ concurrency: 1 });
    await say(live, 'alice', 0);
    await say(live, 'bob', 2_000);
    expect(stt.requests).toHaveLength(1);
    stt.requests[0]!.done('one');
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.requests).toHaveLength(2);
  });

  it('skips empty results and survives a failing request', async () => {
    const live = make({ concurrency: 1 });
    await say(live, 'alice', 0);
    await say(live, 'alice', 2_000);
    await say(live, 'alice', 4_000);
    stt.requests[0]!.done(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    stt.requests[1]!.done('  ');
    await vi.advanceTimersByTimeAsync(0);
    stt.requests[2]!.done('still here');
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.map((l) => l.text)).toEqual(['still here']);
  });

  it('drops utterances that waited too long in the queue', async () => {
    const live = make({ concurrency: 1, maxAgeMs: 30_000 });
    await say(live, 'alice', 0);
    await say(live, 'bob', 2_000);
    clock = 31_000;
    stt.requests[0]!.done('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.requests).toHaveLength(1); // bob's was dropped, not sent
  });

  it('stop() sends the open utterance, waits for the results, then goes quiet', async () => {
    const live = make();
    for (let i = 0; i < 25; i++) live.push('alice', voice, i * 20);
    const stopped = live.stop(5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(stt.requests).toHaveLength(1);
    stt.requests[0]!.done('last words');
    await stopped;
    expect(lines.map((l) => l.text)).toEqual(['last words']);
    live.push('alice', voice, 9_000); // after stop: ignored
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stt.requests).toHaveLength(1);
  });

  it('stop() gives up after the drain time and ignores late results', async () => {
    const live = make();
    await say(live, 'alice', 0);
    const stopped = live.stop(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    stt.requests[0]!.done('too late');
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toEqual([]);
  });
});
