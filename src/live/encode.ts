import { OggOpusWriter } from '../recorder/ogg.js';
import { opusPacketSamples } from '../recorder/opus.js';

/** Samples the decoder discards at the start: the minimum warm-up libopus needs. */
const PRE_SKIP = 312;

/** Wraps Discord's Opus packets in an in-memory Ogg Opus file, which every Whisper-style server decodes. */
export function encodeUtterance(packets: readonly Buffer[]): Buffer {
  const pages: Buffer[] = [];
  const writer = new OggOpusWriter({ sink: (page) => pages.push(page), preSkip: PRE_SKIP });
  for (const packet of packets) writer.writePacket(packet, opusPacketSamples(packet));
  writer.end();
  return Buffer.concat(pages);
}
