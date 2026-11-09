import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SessionManifest } from '../sessions/manifest.js';
import type { SttProvider } from '../stt/index.js';
import { detectSpeech, extractChunk, planChunks, type TimeRange } from '../transcript/speech.js';
import { mergeSegments, renderTranscriptMarkdown, type Transcript, type TranscriptSegment } from '../transcript/transcript.js';
import { mapLimit } from './concurrency.js';
import { readJsonFile, STT_WORK_DIR, TRANSCRIPT_DATA_FILE, TRANSCRIPT_FILE, writeJsonFile } from './files.js';
import type { PipelineStep, StepContext } from './runner.js';
import { writeFileAtomic } from '../sessions/store.js';

const CachedSegments = z.array(z.object({ startMs: z.number(), endMs: z.number(), text: z.string() }));

export interface TranscribeStepOptions {
  stt: SttProvider;
  ffmpegPath: string;
  /** Parallel requests to the STT provider. */
  concurrency?: number;
}

interface ChunkJob {
  userId: string;
  speaker: string;
  track: string;
  range: TimeRange;
}

/**
 * Transcribes each speaker's track separately (so every line has the right speaker),
 * sending only the stretches with speech, then merges everything into one timeline.
 * Writes `transcript.json` and `transcript.md`.
 */
export function transcribeStep({ stt, ffmpegPath, concurrency = 3 }: TranscribeStepOptions): PipelineStep {
  return {
    name: 'transcribe',
    async run({ manifest, logger, resolve }: StepContext) {
      const workDir = resolve(STT_WORK_DIR);
      await mkdir(workDir, { recursive: true });
      const names = new Map(manifest.participants.map((p) => [p.id, p.name]));

      const jobs: ChunkJob[] = [];
      for (const track of manifest.tracks) {
        const file = resolve(track.file);
        const size = await stat(file).then((s) => s.size, () => 0);
        if (size === 0) {
          logger.warn('Skipping missing or empty track', { file: track.file });
          continue;
        }
        const { regions } = await detectSpeech(ffmpegPath, file);
        const speaker = names.get(track.userId) ?? track.userId;
        for (const range of planChunks(regions)) jobs.push({ userId: track.userId, speaker, track: file, range });
      }
      const speechMs = jobs.reduce((sum, job) => sum + job.range.endMs - job.range.startMs, 0);
      logger.info('Transcribing', { provider: stt.name, tracks: manifest.tracks.length, chunks: jobs.length, speechMs });

      const prompt = sttPrompt(manifest);
      const perChunk = await mapLimit(jobs, concurrency, async (job): Promise<TranscriptSegment[]> => {
        const key = `${job.userId}-${job.range.startMs}-${job.range.endMs}`;
        const cacheFile = path.join(workDir, `${key}.json`);
        let segments = await readJsonFile(cacheFile, CachedSegments);
        if (!segments) {
          const audio = path.join(workDir, `${key}.ogg`);
          await extractChunk(ffmpegPath, job.track, audio, job.range);
          segments = await stt.transcribe({ file: audio, durationMs: job.range.endMs - job.range.startMs, prompt });
          await writeJsonFile(cacheFile, segments);
          await rm(audio, { force: true });
        }
        return segments.map((segment) => ({
          speakerId: job.userId,
          speaker: job.speaker,
          startMs: job.range.startMs + segment.startMs,
          endMs: job.range.startMs + segment.endMs,
          text: segment.text,
        }));
      });

      const transcript: Transcript = { version: 1, sessionId: manifest.id, turns: mergeSegments(perChunk.flat()) };
      await writeJsonFile(resolve(TRANSCRIPT_DATA_FILE), transcript);
      await writeFileAtomic(resolve(TRANSCRIPT_FILE), renderTranscriptMarkdown(manifest, transcript.turns));
      manifest.transcriptDataFile = TRANSCRIPT_DATA_FILE;
      manifest.transcriptFile = TRANSCRIPT_FILE;
      logger.info('Transcript written', { turns: transcript.turns.length });
    },
  };
}

/** Helps the speech model spell names and topic words. Kept short: Whisper reads only ~200 tokens. */
export function sttPrompt(manifest: SessionManifest): string {
  const names = manifest.participants.map((p) => p.name).join(', ');
  return `Meeting: ${manifest.title}.${names ? ` Participants: ${names}.` : ''}`.slice(0, 500);
}
