import { describe, expect, it } from 'vitest';
import { parseOggPages } from '../test-utils/ogg-reader.js';
import { OggOpusWriter } from './ogg.js';
import { OPUS_SILENCE_FRAME } from './opus.js';
import { TimelineTrack } from './track.js';

// A distinguishable 20 ms CELT packet (TOC 0xfc = config 31, stereo, one frame).
const voice = (marker: number) => Buffer.from([0xfc, marker, marker]);

function setup(startMs = 1_000_000) {
  const pages: Buffer[] = [];
  let clock = startMs;
  const writer = new OggOpusWriter({ sink: (p) => pages.push(p), serial: 1 });
  const track = new TimelineTrack({ writer, sessionStartMs: startMs, now: () => clock });
  return {
    track,
    advance: (ms: number) => {
      clock += ms;
    },
    at: (ms: number) => startMs + ms,
    packets: () => {
      track.flush();
      return parseOggPages(Buffer.concat(pages))
        .slice(2)
        .flatMap((p) => p.packets);
    },
  };
}

const isSilence = (p: Buffer) => p.equals(OPUS_SILENCE_FRAME);

describe('TimelineTrack', () => {
  it('pads with silence when a speaker first talks after the meeting started', () => {
    const { track, advance, packets } = setup();
    advance(1000); // first packet arrives 1 s in: it covers 980–1000 ms
    track.pushPacket(voice(1));

    const written = packets();
    expect(written.slice(0, 49).every(isSilence)).toBe(true);
    expect(written[49]).toEqual(voice(1));
    expect(track.durationMs).toBe(1000);
  });

  it('does not insert silence for continuous speech with normal jitter', () => {
    const { track, advance, packets } = setup();
    advance(20);
    for (let i = 0; i < 50; i++) {
      track.pushPacket(voice(i));
      advance(i % 2 === 0 ? 35 : 5); // jittery arrival, averaging 20 ms
    }
    expect(packets().some(isSilence)).toBe(false);
    expect(track.durationMs).toBe(1000);
  });

  it('fills the gap between two bursts of speech', () => {
    const { track, advance, packets } = setup();
    advance(20);
    track.pushPacket(voice(1)); // 0–20 ms
    advance(2000);
    track.pushPacket(voice(2)); // should land at 2000–2020 ms

    const written = packets();
    expect(written[0]).toEqual(voice(1));
    expect(written.slice(1, -1).every(isSilence)).toBe(true);
    expect(written).toHaveLength(101);
    expect(track.durationMs).toBe(2020);
  });

  it('keeps tracks of different speakers aligned to the same clock', () => {
    const a = setup();
    const b = setup();
    a.advance(500);
    a.track.pushPacket(voice(1));
    b.advance(3000);
    b.track.pushPacket(voice(2));

    a.track.padTo(a.at(5000));
    b.track.padTo(b.at(5000));
    expect(a.track.durationMs).toBe(5000);
    expect(b.track.durationMs).toBe(5000);
    expect(a.packets().findIndex((p) => !isSilence(p))).toBe(24); // 480–500 ms
    expect(b.packets().findIndex((p) => !isSilence(p))).toBe(149); // 2980–3000 ms
  });

  it('ignores empty or malformed packets', () => {
    const { track, advance, packets } = setup();
    advance(1000);
    track.pushPacket(Buffer.alloc(0));
    expect(track.receivedPackets).toBe(0);
    expect(packets()).toHaveLength(0);
  });

  it('padTo never moves backwards', () => {
    const { track, advance, at } = setup();
    advance(1000);
    track.pushPacket(voice(1));
    track.padTo(at(500));
    expect(track.durationMs).toBe(1000);
  });
});
