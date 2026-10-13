import { describe, expect, it } from 'vitest';
import { parseFfmpegDurationMs, parseSilences, planChunks, speechRegions } from './speech.js';

// Trimmed real ffmpeg output: silencedetect lines plus progress lines separated by \r.
const STDERR = [
  "Input #0, ogg, from 'tracks/u1.ogg':",
  '[silencedetect @ 0x6000] silence_start: 0',
  '[silencedetect @ 0x6000] silence_end: 2.48 | silence_duration: 2.48',
  '[silencedetect @ 0x6000] silence_start: 3.52',
  'size=N/A time=00:00:04.00 bitrate=N/A speed= 800x\r[silencedetect @ 0x6000] silence_end: 20.1 | silence_duration: 16.58',
  '[silencedetect @ 0x6000] silence_start: 25.3',
  'size=N/A time=00:01:00.00 bitrate=N/A speed= 900x',
].join('\n');

describe('ffmpeg output parsing', () => {
  it('reads silences, leaving a trailing one open', () => {
    expect(parseSilences(STDERR)).toEqual([
      { startMs: 0, endMs: 2480 },
      { startMs: 3520, endMs: 20_100 },
      { startMs: 25_300 },
    ]);
  });

  it('reads the decoded duration from the last progress line', () => {
    expect(parseFfmpegDurationMs(STDERR)).toBe(60_000);
    expect(parseFfmpegDurationMs('time=01:02:03.50')).toBe(3_723_500);
    expect(parseFfmpegDurationMs('no progress')).toBeUndefined();
  });

  it('clamps the slightly negative start Opus pre-skip can produce', () => {
    expect(parseSilences('silence_start: -0.0065\nsilence_end: 1')).toEqual([{ startMs: 0, endMs: 1000 }]);
  });
});

describe('speechRegions', () => {
  it('returns the padded gaps between silences', () => {
    expect(speechRegions(parseSilences(STDERR), 60_000)).toEqual([
      { startMs: 2230, endMs: 3770 },
      { startMs: 19_850, endMs: 25_550 },
    ]);
  });

  it('handles speech at the very start and end', () => {
    expect(speechRegions([{ startMs: 1000, endMs: 5000 }], 6000)).toEqual([
      { startMs: 0, endMs: 1250 },
      { startMs: 4750, endMs: 6000 },
    ]);
  });

  it('returns nothing for a silent track and ignores tiny blips', () => {
    expect(speechRegions([{ startMs: 0 }], 60_000)).toEqual([]);
    expect(speechRegions([{ startMs: 0, endMs: 10_000 }, { startMs: 10_100 }], 60_000)).toEqual([]);
  });

  it('merges regions whose padding overlaps', () => {
    const silences = [{ startMs: 0, endMs: 1000 }, { startMs: 1300, endMs: 1500 }, { startMs: 1800 }];
    expect(speechRegions(silences, 3000)).toEqual([{ startMs: 750, endMs: 2050 }]);
  });
});

describe('planChunks', () => {
  it('groups nearby speech and splits at long silences', () => {
    const regions = [
      { startMs: 0, endMs: 5_000 },
      { startMs: 8_000, endMs: 12_000 }, // 3 s gap: same chunk
      { startMs: 60_000, endMs: 61_000 }, // 48 s gap: new chunk
    ];
    expect(planChunks(regions)).toEqual([
      { startMs: 0, endMs: 12_000 },
      { startMs: 60_000, endMs: 61_000 },
    ]);
  });

  it('caps chunk length, cutting long monologues', () => {
    expect(planChunks([{ startMs: 0, endMs: 25_000 }], { maxChunkMs: 10_000 })).toEqual([
      { startMs: 0, endMs: 10_000 },
      { startMs: 10_000, endMs: 20_000 },
      { startMs: 20_000, endMs: 25_000 },
    ]);
    expect(
      planChunks(
        [
          { startMs: 0, endMs: 6_000 },
          { startMs: 7_000, endMs: 12_000 },
        ],
        { maxChunkMs: 10_000 },
      ),
    ).toEqual([
      { startMs: 0, endMs: 6_000 },
      { startMs: 7_000, endMs: 12_000 },
    ]);
  });
});
