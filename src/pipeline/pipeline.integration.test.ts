import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { OggOpusWriter } from '../recorder/ogg.js';
import { TimelineTrack } from '../recorder/track.js';
import type { SessionManifest } from '../sessions/manifest.js';
import { SessionStore } from '../sessions/store.js';
import type { SttProvider, TranscribeRequest } from '../stt/index.js';
import { MockChatModel } from '../summarize/mock.js';
import { Summarizer } from '../summarize/summarizer.js';
import { Summary } from '../summarize/summary.js';
import { readOggPackets } from '../test-utils/ogg-reader.js';
import { Transcript } from '../transcript/transcript.js';
import { mixStep } from './mix-step.js';
import { Pipeline } from './runner.js';
import { summarizeStep } from './summarize-step.js';
import { transcribeStep } from './transcribe-step.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/**
 * Real tracks (Opus tones placed on the meeting timeline) through speech detection, chunk
 * extraction and the full pipeline, with a fake STT provider that checks what it receives.
 */
describe.skipIf(!hasFfmpeg)('processing pipeline with real ffmpeg', () => {
  let dir: string;
  let store: SessionStore;
  let tonePackets: Buffer[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-pipeline-'));
    store = new SessionStore(path.join(dir, 'sessions'), silentLogger);
    const tone = path.join(dir, 'tone.ogg');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ac', '2', '-c:a', 'libopus', '-b:a', '64k', '-frame_duration', '20', tone,
    ]);
    tonePackets = readOggPackets(await readFile(tone)).slice(2);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A track of `lengthMs` with a 1 s "utterance" starting at each of `speechAtMs`. */
  async function writeTrack(file: string, speechAtMs: number[], lengthMs: number): Promise<void> {
    const pages: Buffer[] = [];
    let clock = 0;
    const writer = new OggOpusWriter({ sink: (p) => pages.push(p) });
    const track = new TimelineTrack({ writer, sessionStartMs: 0, now: () => clock });
    for (const start of speechAtMs) {
      tonePackets.forEach((packet, i) => {
        clock = start + (i + 1) * 20;
        track.pushPacket(packet);
      });
    }
    track.padTo(lengthMs);
    track.end();
    await writeFile(file, Buffer.concat(pages));
  }

  const durationMs = (file: string) =>
    1000 * Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

  it('mixes, transcribes each speaker separately, places lines on the meeting timeline and summarizes', async () => {
    const manifest: SessionManifest = {
      version: 1,
      id: 's1',
      title: 'Weekly sync',
      trigger: 'manual',
      status: 'recorded',
      guildId: 'g',
      voiceChannelId: 'v',
      voiceChannelName: 'General',
      startedBy: { id: 'u1', name: 'Alice' },
      startedAt: '2026-10-13T14:00:00.000Z',
      participants: [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
      ],
      tracks: [
        { userId: 'u1', file: 'tracks/u1.ogg' },
        { userId: 'u2', file: 'tracks/u2.ogg' },
      ],
      pauses: [],
      bookmarks: [{ atMs: 10_000, text: 'Bob joins in', by: { id: 'u1', name: 'Alice' } }],
      durationMs: 45_000,
    };
    await store.create(manifest);
    // Alice speaks at 2 s and 40 s (a long gap: two chunks), Bob at 10 s.
    await writeTrack(store.resolve('s1', 'tracks/u1.ogg'), [2_000, 40_000], 45_000);
    await writeTrack(store.resolve('s1', 'tracks/u2.ogg'), [10_000], 45_000);

    const requests: { file: string; durationMs: number; measuredMs: number; prompt?: string | undefined }[] = [];
    const stt: SttProvider = {
      name: 'fake',
      transcribe: async (request: TranscribeRequest) => {
        requests.push({ ...request, measuredMs: durationMs(request.file) });
        return [{ startMs: 200, endMs: request.durationMs - 200, text: `utterance ${requests.length}` }];
      },
    };
    const transcribe = transcribeStep({ stt, ffmpegPath: 'ffmpeg', concurrency: 1 });
    const steps = [
      mixStep({ ffmpegPath: 'ffmpeg' }),
      transcribe,
      summarizeStep({ summarizer: new Summarizer({ model: new MockChatModel(), chunkChars: 10_000, logger: silentLogger }) }),
    ];
    await new Pipeline({ store, steps, logger: silentLogger }).enqueue('s1');

    const result = await store.load('s1');
    expect(result.processing?.mix?.status).toBe('done');
    expect(result.processing?.transcribe?.status).toBe('done');
    expect(result.processing?.summarize?.status).toBe('done');
    expect(result.mixedFile).toBe('mixed.ogg');
    expect(durationMs(store.resolve('s1', 'mixed.ogg'))).toBeCloseTo(45_000, -3);

    // Only the speech is sent: three ~1.5 s chunks (1 s tone + padding), not 2 × 45 s of audio.
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.durationMs).toBeGreaterThan(1_000);
      expect(request.durationMs).toBeLessThan(2_500);
      expect(request.measuredMs).toBeCloseTo(request.durationMs, -2);
      expect(request.prompt).toBe('Meeting: Weekly sync. Participants: Alice, Bob.');
    }

    const transcript = Transcript.parse(JSON.parse(await readFile(store.resolve('s1', 'transcript.json'), 'utf8')));
    expect(transcript.turns.map((t) => t.speaker)).toEqual(['Alice', 'Bob', 'Alice']);
    const starts = transcript.turns.map((t) => t.startMs / 1000);
    expect(starts[0]).toBeCloseTo(2, 0);
    expect(starts[1]).toBeCloseTo(10, 0);
    expect(starts[2]).toBeCloseTo(40, 0);

    const markdown = await readFile(store.resolve('s1', 'transcript.md'), 'utf8');
    expect(markdown).toMatch(/\*\*\[00:0[12]\] Alice:\*\* utterance/);
    expect(markdown).toMatch(/\*\*\[00:(09|10)\] Bob:\*\* utterance/);

    const summary = Summary.parse(JSON.parse(await readFile(store.resolve('s1', 'summary.json'), 'utf8')));
    expect(summary.tldr).toBe('Mock summary of 3 transcript line(s).');

    // Chunk audio is deleted once transcribed; the per-chunk results are cached.
    const work = await readdir(store.resolve('s1', 'work/stt'));
    expect(work.filter((f) => f.endsWith('.ogg'))).toEqual([]);
    expect(work.filter((f) => f.endsWith('.json'))).toHaveLength(3);

    // Running the transcription again (e.g. after a crash) costs no new STT calls.
    await transcribe.run({ manifest: result, logger: silentLogger, resolve: (f) => store.resolve('s1', f), checkpoint: async () => {} });
    expect(requests).toHaveLength(3);
  });
});
