import { OPUS_SAMPLE_RATE } from './opus.js';

// Ogg page header flags (RFC 3533 §6).
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;

const MAX_SEGMENTS_PER_PAGE = 255;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    }
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, zero init, no final XOR. */
export function oggCrc32(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

/** Ogg lacing: a packet of n bytes is split into 255-byte segments plus a final one (< 255, may be 0). */
function lacingValues(length: number): number[] {
  const values: number[] = new Array<number>(Math.floor(length / 255)).fill(255);
  values.push(length % 255);
  return values;
}

export interface OggOpusWriterOptions {
  /** Called with each complete page; typically appends it to a file. */
  sink: (page: Buffer) => void;
  /** Ogg stream serial number. Random when omitted. */
  serial?: number;
  channels?: number;
  /** Samples to discard at the start of playback (OpusHead pre-skip). */
  preSkip?: number;
  vendor?: string;
  /** Emit a page once this many packets are buffered. 50 × 20 ms = at most 1 s of audio per page. */
  maxPacketsPerPage?: number;
}

/**
 * Streams already-encoded Opus packets into an Ogg Opus file (RFC 7845) without re-encoding.
 * Pages are emitted as they fill (or on `flush()`), so a crash loses at most one page.
 */
export class OggOpusWriter {
  private readonly sink: (page: Buffer) => void;
  private readonly serial: number;
  private readonly maxPacketsPerPage: number;
  private sequence = 0;
  private granule = 0n;
  private pendingPackets: Buffer[] = [];
  private pendingSegments = 0;
  private ended = false;

  constructor(options: OggOpusWriterOptions) {
    this.sink = options.sink;
    this.serial = options.serial ?? Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.maxPacketsPerPage = options.maxPacketsPerPage ?? 50;
    this.writeHeaders(options.channels ?? 2, options.preSkip ?? 0, options.vendor ?? 'turing-voice-bot');
  }

  /** Total samples (48 kHz) written so far, i.e. the stream's current granule position. */
  get samplesWritten(): number {
    return Number(this.granule);
  }

  writePacket(packet: Uint8Array, samples: number): void {
    if (this.ended) throw new Error('OggOpusWriter: cannot write after end()');
    const segments = lacingValues(packet.length).length;
    if (segments > MAX_SEGMENTS_PER_PAGE) throw new Error(`Opus packet too large: ${packet.length} bytes`);
    if (this.pendingSegments + segments > MAX_SEGMENTS_PER_PAGE) this.flush();

    this.pendingPackets.push(Buffer.from(packet));
    this.pendingSegments += segments;
    this.granule += BigInt(samples);

    if (this.pendingPackets.length >= this.maxPacketsPerPage) this.flush();
  }

  /** Emits buffered packets as a page now, even if it is not full. */
  flush(): void {
    if (this.pendingPackets.length === 0) return;
    this.emitPage(this.pendingPackets, 0, this.granule);
    this.pendingPackets = [];
    this.pendingSegments = 0;
  }

  /** Flushes remaining packets and marks the end of the stream. Further writes throw. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.emitPage(this.pendingPackets, FLAG_EOS, this.granule);
    this.pendingPackets = [];
    this.pendingSegments = 0;
  }

  private writeHeaders(channels: number, preSkip: number, vendor: string): void {
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head.writeUInt8(1, 8); // version
    head.writeUInt8(channels, 9);
    head.writeUInt16LE(preSkip, 10);
    head.writeUInt32LE(OPUS_SAMPLE_RATE, 12); // original input rate (informational)
    head.writeInt16LE(0, 16); // output gain
    head.writeUInt8(0, 18); // channel mapping family 0: mono/stereo
    this.emitPage([head], FLAG_BOS, 0n);

    const vendorBytes = Buffer.from(vendor, 'utf8');
    const tags = Buffer.alloc(8 + 4 + vendorBytes.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendorBytes.length, 8);
    vendorBytes.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendorBytes.length); // no user comments
    this.emitPage([tags], 0, 0n);
  }

  private emitPage(packets: Buffer[], flags: number, granule: bigint): void {
    const lacing = packets.flatMap((p) => lacingValues(p.length));
    const bodyLength = packets.reduce((sum, p) => sum + p.length, 0);
    const page = Buffer.alloc(27 + lacing.length + bodyLength);

    page.write('OggS', 0, 'ascii');
    page.writeUInt8(0, 4); // stream structure version
    page.writeUInt8(flags, 5);
    page.writeBigInt64LE(granule, 6);
    page.writeUInt32LE(this.serial, 14);
    page.writeUInt32LE(this.sequence++, 18);
    page.writeUInt32LE(0, 22); // CRC placeholder
    page.writeUInt8(lacing.length, 26);
    Buffer.from(lacing).copy(page, 27);
    let offset = 27 + lacing.length;
    for (const packet of packets) {
      packet.copy(page, offset);
      offset += packet.length;
    }
    page.writeUInt32LE(oggCrc32(page), 22);

    this.sink(page);
  }
}
