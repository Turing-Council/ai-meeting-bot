import { describe, expect, it } from 'vitest';
import { OPUS_SILENCE_FRAME, opusPacketSamples } from './opus.js';

const toc = (config: number, stereo: boolean, code: number) => (config << 3) | (stereo ? 0x04 : 0) | code;

describe('opusPacketSamples', () => {
  it('reads the 20 ms silence frame Discord sends', () => {
    expect(opusPacketSamples(OPUS_SILENCE_FRAME)).toBe(960);
  });

  it('handles single-frame packets across SILK, Hybrid and CELT configs', () => {
    expect(opusPacketSamples(Buffer.from([toc(0, false, 0), 0]))).toBe(480); // SILK NB 10 ms
    expect(opusPacketSamples(Buffer.from([toc(3, true, 0), 0]))).toBe(2880); // SILK NB 60 ms
    expect(opusPacketSamples(Buffer.from([toc(13, true, 0), 0]))).toBe(960); // Hybrid SWB 20 ms
    expect(opusPacketSamples(Buffer.from([toc(16, true, 0), 0]))).toBe(120); // CELT 2.5 ms
    expect(opusPacketSamples(Buffer.from([toc(31, true, 0), 0]))).toBe(960); // CELT FB 20 ms
  });

  it('counts two frames for codes 1 and 2', () => {
    expect(opusPacketSamples(Buffer.from([toc(31, true, 1), 0]))).toBe(1920);
    expect(opusPacketSamples(Buffer.from([toc(31, true, 2), 1, 0]))).toBe(1920);
  });

  it('reads the frame count byte for code 3', () => {
    expect(opusPacketSamples(Buffer.from([toc(31, true, 3), 3]))).toBe(2880);
  });

  it('returns 0 for empty, truncated or oversized packets', () => {
    expect(opusPacketSamples(Buffer.alloc(0))).toBe(0);
    expect(opusPacketSamples(Buffer.from([toc(31, true, 3)]))).toBe(0); // missing count byte
    expect(opusPacketSamples(Buffer.from([toc(31, true, 3), 0]))).toBe(0); // zero frames
    expect(opusPacketSamples(Buffer.from([toc(3, true, 3), 3]))).toBe(0); // 180 ms > 120 ms limit
  });
});
