import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readOggPackets } from '../test-utils/ogg-reader.js';
import { mixdown } from './mixdown.js';
import { OggOpusWriter } from './ogg.js';
import { TimelineTrack } from './track.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/**
 * End-to-end check against real Opus audio: ffmpeg encodes a tone, we re-mux its packets
 * through TimelineTrack/OggOpusWriter at a known time, and ffmpeg must decode, mix and
 * measure the result correctly. Runs where ffmpeg is installed (e.g. the Docker test stage).
 */
describe.skipIf(!hasFfmpeg)('recording pipeline with real ffmpeg', () => {
  let dir: string;
  let tonePackets: Buffer[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-ffmpeg-'));
    const tone = path.join(dir, 'tone.ogg');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-frame_duration', '20', tone,
    ]);
    tonePackets = readOggPackets(await readFile(tone)).slice(2); // drop OpusHead + OpusTags
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes a 5 s track where the 1 s tone starts at `speechStartMs`, simulating real-time arrival. */
  async function writeTrack(name: string, speechStartMs: number, truncateBytes = 0): Promise<string> {
    const pages: Buffer[] = [];
    let clock = 0;
    const writer = new OggOpusWriter({ sink: (p) => pages.push(p) });
    const track = new TimelineTrack({ writer, sessionStartMs: 0, now: () => clock });
    tonePackets.forEach((packet, i) => {
      clock = speechStartMs + (i + 1) * 20;
      track.pushPacket(packet);
    });
    track.padTo(5000);
    track.end();
    const file = path.join(dir, name);
    const bytes = Buffer.concat(pages);
    await writeFile(file, bytes.subarray(0, bytes.length - truncateBytes));
    return file;
  }

  const durationSeconds = (file: string) =>
    Number(
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim(),
    );

  /** Where the first long silence ends, i.e. when speech starts. */
  const speechStartSeconds = (file: string) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=n=-40dB:d=0.3', '-f', 'null', '-']);
    const match = /silence_end: ([\d.]+)/.exec(result.stderr.toString());
    return match ? Number(match[1]) : undefined;
  };

  it('produces a valid Ogg Opus file of the expected length', async () => {
    const file = await writeTrack('a.ogg', 2000);
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']);
    expect(decode.status).toBe(0);
    expect(decode.stderr.toString()).toBe('');
    expect(durationSeconds(file)).toBeCloseTo(5, 1);
  });

  it('places speech at the right time on the meeting timeline', async () => {
    const file = await writeTrack('b.ogg', 2000);
    expect(speechStartSeconds(file)).toBeCloseTo(2, 1);
  });

  it('mixes several speakers into one file that keeps both voices in place', async () => {
    const a = await writeTrack('mix-a.ogg', 500);
    const b = await writeTrack('mix-b.ogg', 3000);
    const out = path.join(dir, 'mixed.ogg');
    await mixdown('ffmpeg', [a, b], out);

    expect(durationSeconds(out)).toBeCloseTo(5, 1);
    expect(speechStartSeconds(out)).toBeCloseTo(0.5, 1);
    // Both tones present: loud in 0.5–1.5 s and 3–4 s, silent between.
    const silences = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'silencedetect=n=-40dB:d=0.3', '-f', 'null', '-'])
      .stderr.toString()
      .match(/silence_end: [\d.]+/g);
    expect(silences?.length).toBeGreaterThanOrEqual(2);
  });

  it('a file cut off mid-page (crash) still decodes and mixes', async () => {
    const file = await writeTrack('crashed.ogg', 1000, 37);
    const out = path.join(dir, 'crashed-mixed.ogg');
    await mixdown('ffmpeg', [file], out);
    expect(durationSeconds(out)).toBeGreaterThan(4);
  });
});
