import { describe, expect, it } from 'vitest';
import { parseOggPages } from '../test-utils/ogg-reader.js';
import { OggOpusWriter, oggCrc32 } from './ogg.js';
import { OPUS_SILENCE_FRAME } from './opus.js';

function collect(maxPacketsPerPage?: number) {
  const pages: Buffer[] = [];
  const writer = new OggOpusWriter({
    sink: (page) => pages.push(page),
    serial: 0x1234,
    ...(maxPacketsPerPage ? { maxPacketsPerPage } : {}),
  });
  return { writer, bytes: () => Buffer.concat(pages), pageCount: () => pages.length };
}

describe('oggCrc32', () => {
  it('matches the known check value for the Ogg polynomial', () => {
    // CRC-32/MPEG-2 style without init/xorout ("CRC-32/OGG"): check value for "123456789".
    expect(oggCrc32(Buffer.from('123456789'))).toBe(0x89a1897f);
  });
});

describe('OggOpusWriter', () => {
  it('writes OpusHead (BOS) and OpusTags as the first two pages', () => {
    const { bytes } = collect();
    const pages = parseOggPages(bytes());

    expect(pages).toHaveLength(2);
    expect(pages[0]!.flags).toBe(0x02);
    expect(pages[0]!.packets[0]!.toString('ascii', 0, 8)).toBe('OpusHead');
    expect(pages[0]!.packets[0]!.readUInt8(9)).toBe(2); // stereo
    expect(pages[1]!.packets[0]!.toString('ascii', 0, 8)).toBe('OpusTags');
    expect(pages.every((p) => p.crcValid && p.serial === 0x1234)).toBe(true);
  });

  it('round-trips packets with valid CRCs, sequence numbers and granule positions', () => {
    const { writer, bytes } = collect(3);
    const input = Array.from({ length: 7 }, (_, i) => Buffer.from([0xfc, i, i, i]));
    for (const packet of input) writer.writePacket(packet, 960);
    writer.end();

    const pages = parseOggPages(bytes());
    const audio = pages.slice(2);

    expect(audio.flatMap((p) => p.packets)).toEqual(input);
    expect(pages.every((p) => p.crcValid)).toBe(true);
    expect(pages.map((p) => p.sequence)).toEqual(pages.map((_, i) => i));
    // Pages of 3, 3, then the final 1 packet flushed with EOS.
    expect(audio.map((p) => p.granule)).toEqual([2880n, 5760n, 6720n]);
    expect(audio.at(-1)!.flags & 0x04).toBe(0x04);
    expect(writer.samplesWritten).toBe(6720);
  });

  it('laces packets of 255+ bytes correctly', () => {
    const { writer, bytes } = collect();
    const sizes = [254, 255, 256, 510, 1275];
    const input = sizes.map((size, i) => Buffer.alloc(size, i + 1));
    for (const packet of input) writer.writePacket(packet, 960);
    writer.end();

    const packets = parseOggPages(bytes()).slice(2).flatMap((p) => p.packets);
    expect(packets.map((p) => p.length)).toEqual(sizes);
    expect(packets).toEqual(input);
  });

  it('never exceeds 255 segments per page', () => {
    const { writer, bytes } = collect(1000);
    for (let i = 0; i < 300; i++) writer.writePacket(OPUS_SILENCE_FRAME, 960);
    writer.end();

    const pages = parseOggPages(bytes());
    expect(pages.slice(2).flatMap((p) => p.packets)).toHaveLength(300);
    for (const page of pages) expect(page.packets.length).toBeLessThanOrEqual(255);
  });

  it('flush() emits a partial page so data reaches disk early', () => {
    const { writer, pageCount } = collect();
    writer.writePacket(OPUS_SILENCE_FRAME, 960);
    expect(pageCount()).toBe(2);
    writer.flush();
    expect(pageCount()).toBe(3);
    writer.flush(); // nothing pending: no empty page
    expect(pageCount()).toBe(3);
  });

  it('end() with nothing pending still writes an EOS page, and later writes throw', () => {
    const { writer, bytes } = collect();
    writer.end();
    writer.end(); // idempotent
    const pages = parseOggPages(bytes());
    expect(pages).toHaveLength(3);
    expect(pages[2]!.flags).toBe(0x04);
    expect(() => writer.writePacket(OPUS_SILENCE_FRAME, 960)).toThrow();
  });
});
