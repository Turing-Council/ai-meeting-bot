import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPUS_SILENCE_FRAME } from '../recorder/opus.js';
import { parseOggPages } from '../test-utils/ogg-reader.js';
import { encodeUtterance } from './encode.js';
import { UtteranceSegmenter, type Utterance } from './segmenter.js';

const voice = (marker: number) => Buffer.from([0xfc, marker, marker]); // 20 ms CELT frame

describe('UtteranceSegmenter', () => {
  let out: Utterance[];
  const make = (options: { silenceMs?: number; maxMs?: number; minMs?: number } = {}) =>
    new UtteranceSegmenter({ silenceMs: 800, maxMs: 20_000, minMs: 400, onUtterance: (u) => out.push(u), ...options });
  /** 25 voice packets = 500 ms of speech, arriving 20 ms apart from `fromMs`. */
  const speak = (s: UtteranceSegmenter, userId: string, fromMs: number, packets = 25) => {
    for (let i = 0; i < packets; i++) s.push(userId, voice(i), fromMs + i * 20);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    out = [];
  });
  afterEach(() => vi.useRealTimers());

  it('closes an utterance after a pause and timestamps it from its first packet', () => {
    const s = make();
    speak(s, 'alice', 5_000);
    vi.advanceTimersByTime(799);
    expect(out).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ userId: 'alice', startMs: 4_980, endMs: 5_480 });
    expect(out[0]!.packets).toHaveLength(25);
  });

  it('keeps one utterance together across short gaps', () => {
    const s = make();
    speak(s, 'alice', 0);
    vi.advanceTimersByTime(500);
    speak(s, 'alice', 1_000);
    vi.advanceTimersByTime(800);
    expect(out).toHaveLength(1);
    expect(out[0]!.packets).toHaveLength(50);
  });

  it('drops Discord end-of-speech silence frames', () => {
    const s = make();
    speak(s, 'alice', 0);
    for (let i = 0; i < 5; i++) s.push('alice', OPUS_SILENCE_FRAME, 500 + i * 20);
    vi.advanceTimersByTime(800);
    expect(out[0]!.packets).toHaveLength(25);
  });

  it('ignores blips shorter than the minimum', () => {
    const s = make();
    speak(s, 'alice', 0, 10); // 200 ms
    vi.advanceTimersByTime(800);
    expect(out).toHaveLength(0);
  });

  it('cuts a long monologue at the maximum length', () => {
    const s = make({ maxMs: 1_000 });
    speak(s, 'alice', 0, 120); // 2.4 s
    vi.advanceTimersByTime(800);
    expect(out.map((u) => u.packets.length)).toEqual([50, 50, 20]);
    expect(out[1]!.startMs).toBe(980);
  });

  it('segments speakers independently', () => {
    const s = make();
    speak(s, 'alice', 0);
    speak(s, 'bob', 100);
    vi.advanceTimersByTime(800);
    expect(out.map((u) => u.userId).sort()).toEqual(['alice', 'bob']);
  });

  it('flush closes what is still open', () => {
    const s = make();
    speak(s, 'alice', 0);
    s.flush();
    expect(out).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(out).toHaveLength(1);
  });
});

describe('encodeUtterance', () => {
  it('wraps packets in an Ogg Opus file with the right length', () => {
    const packets = Array.from({ length: 25 }, (_, i) => voice(i));
    const pages = parseOggPages(encodeUtterance(packets));
    expect(pages.slice(2).flatMap((p) => p.packets)).toHaveLength(25);
    expect(pages.at(-1)!.granule).toBe(25n * 960n);
  });
});
