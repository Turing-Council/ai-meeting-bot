/** Opus always runs at 48 kHz inside Ogg, regardless of the input rate. */
export const OPUS_SAMPLE_RATE = 48_000;

/** Samples in one 20 ms frame at 48 kHz: the frame size Discord sends. */
export const SAMPLES_PER_20MS = 960;

/**
 * A 20 ms Opus silence frame (CELT, fullband). Discord itself sends these at the end of speech,
 * so every decoder handles them. Used to fill gaps between speech bursts.
 */
export const OPUS_SILENCE_FRAME: Buffer = Buffer.from([0xf8, 0xff, 0xfe]);

// Frame duration per TOC configuration number (RFC 6716 §3.1), in units of 1/48000 s.
const FRAME_SAMPLES_BY_CONFIG: readonly number[] = [
  // 0–11 SILK (NB, MB, WB): 10, 20, 40, 60 ms
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
  // 12–15 Hybrid (SWB, FB): 10, 20 ms
  480, 960, 480, 960,
  // 16–31 CELT (NB, WB, SWB, FB): 2.5, 5, 10, 20 ms
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/**
 * Returns how many 48 kHz samples an Opus packet decodes to, by parsing its TOC byte
 * (RFC 6716 §3.1). Returns 0 for empty or malformed packets so callers can skip them.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const frameSamples = FRAME_SAMPLES_BY_CONFIG[toc >> 3]!;
  const code = toc & 0x03;

  let frameCount: number;
  if (code === 0) frameCount = 1;
  else if (code === 1 || code === 2) frameCount = 2;
  else {
    if (packet.length < 2) return 0;
    frameCount = packet[1]! & 0x3f;
  }

  const total = frameSamples * frameCount;
  // RFC 6716: a packet may not exceed 120 ms.
  if (frameCount === 0 || total > 5760) return 0;
  return total;
}
