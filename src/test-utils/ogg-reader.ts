import { oggCrc32 } from '../recorder/ogg.js';

export interface ParsedPage {
  flags: number;
  granule: bigint;
  serial: number;
  sequence: number;
  crcValid: boolean;
  /** Packets that complete on this page (the writer never splits packets across pages). */
  packets: Buffer[];
}

/** Independent Ogg page parser used to check what OggOpusWriter produces. */
export function parseOggPages(data: Buffer): ParsedPage[] {
  const pages: ParsedPage[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (data.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new Error(`Missing capture pattern at offset ${offset}`);
    }
    const segmentCount = data.readUInt8(offset + 26);
    const lacing = [...data.subarray(offset + 27, offset + 27 + segmentCount)];
    const bodyLength = lacing.reduce((a, b) => a + b, 0);
    const pageLength = 27 + segmentCount + bodyLength;
    const page = Buffer.from(data.subarray(offset, offset + pageLength));

    const storedCrc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    const crcValid = oggCrc32(page) === storedCrc;

    const packets: Buffer[] = [];
    let current = 0;
    let packetStart = 27 + segmentCount;
    for (const value of lacing) {
      current += value;
      if (value < 255) {
        packets.push(page.subarray(packetStart, packetStart + current));
        packetStart += current;
        current = 0;
      }
    }

    pages.push({
      flags: page.readUInt8(5),
      granule: page.readBigInt64LE(6),
      serial: page.readUInt32LE(14),
      sequence: page.readUInt32LE(18),
      crcValid,
      packets,
    });
    offset += pageLength;
  }
  return pages;
}

/**
 * Reads every packet of a single-stream Ogg file, including packets that continue across
 * pages (as files from other muxers, e.g. ffmpeg, may contain).
 */
export function readOggPackets(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let partial: Buffer[] = [];
  let offset = 0;
  while (offset + 27 <= data.length && data.toString('ascii', offset, offset + 4) === 'OggS') {
    const segmentCount = data.readUInt8(offset + 26);
    const lacing = data.subarray(offset + 27, offset + 27 + segmentCount);
    let bodyOffset = offset + 27 + segmentCount;
    for (const value of lacing) {
      partial.push(data.subarray(bodyOffset, bodyOffset + value));
      bodyOffset += value;
      if (value < 255) {
        packets.push(Buffer.concat(partial));
        partial = [];
      }
    }
    offset = bodyOffset;
  }
  return packets;
}
