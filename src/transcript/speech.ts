import { runFfmpeg } from '../recorder/mixdown.js';

/** A stretch of audio, in ms from the start of the track (= meeting start). */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface SpeechDetection {
  regions: TimeRange[];
  /** Decoded length of the track, as measured by ffmpeg. */
  durationMs: number;
}

/** Below this level counts as silence. Gaps in a track are digital silence, so this only has to beat room noise. */
const SILENCE_NOISE = '-40dB';
/** Shortest pause that splits speech, in seconds. */
const SILENCE_MIN_S = 1;
/** Extra audio kept around each region so word edges aren't clipped. */
const PAD_MS = 250;
/** Blips shorter than this (clicks, keyboard) are ignored. */
const MIN_REGION_MS = 150;

/** Finds where someone is speaking in a track, using ffmpeg's silencedetect. */
export async function detectSpeech(ffmpegPath: string, file: string): Promise<SpeechDetection> {
  const stderr = await runFfmpeg(ffmpegPath, [
    '-hide_banner',
    '-i', file,
    '-af', `silencedetect=noise=${SILENCE_NOISE}:duration=${SILENCE_MIN_S}`,
    '-f', 'null', '-',
  ]);
  const durationMs = parseFfmpegDurationMs(stderr);
  if (durationMs === undefined) throw new Error(`Could not read the duration of ${file}`);
  return { durationMs, regions: speechRegions(parseSilences(stderr), durationMs) };
}

/** Silences reported by silencedetect. The last one has no end if the track ends in silence. */
export function parseSilences(stderr: string): { startMs: number; endMs?: number }[] {
  const silences: { startMs: number; endMs?: number }[] = [];
  for (const match of stderr.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const ms = Math.max(0, Math.round(Number(match[2]) * 1000));
    if (match[1] === 'start') silences.push({ startMs: ms });
    else {
      const open = silences.at(-1);
      if (open && open.endMs === undefined) open.endMs = ms;
    }
  }
  return silences;
}

/** The last `time=` progress value ffmpeg printed, i.e. how much audio it decoded. */
export function parseFfmpegDurationMs(stderr: string): number | undefined {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (!last) return undefined;
  return Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000);
}

/** Everything that isn't silence, padded and clamped to the track. */
export function speechRegions(silences: { startMs: number; endMs?: number }[], durationMs: number): TimeRange[] {
  const raw: TimeRange[] = [];
  let cursor = 0;
  for (const silence of [...silences].sort((a, b) => a.startMs - b.startMs)) {
    if (silence.startMs > cursor) raw.push({ startMs: cursor, endMs: Math.min(silence.startMs, durationMs) });
    cursor = Math.max(cursor, silence.endMs ?? durationMs);
  }
  if (cursor < durationMs) raw.push({ startMs: cursor, endMs: durationMs });

  const padded: TimeRange[] = [];
  for (const region of raw) {
    if (region.endMs - region.startMs < MIN_REGION_MS) continue;
    const next = { startMs: Math.max(0, region.startMs - PAD_MS), endMs: Math.min(durationMs, region.endMs + PAD_MS) };
    const previous = padded.at(-1);
    if (previous && next.startMs <= previous.endMs) previous.endMs = next.endMs;
    else padded.push(next);
  }
  return padded;
}

export interface ChunkPlanOptions {
  /** Regions closer than this are sent together, so the speech model keeps its context. */
  maxGapMs?: number;
  /** Upper bound for one request; long monologues are cut. */
  maxChunkMs?: number;
}

/**
 * Groups speech regions into the audio chunks sent for transcription. Long silences are never
 * sent (providers bill per audio minute, and silence invites made-up text).
 */
export function planChunks(regions: readonly TimeRange[], options: ChunkPlanOptions = {}): TimeRange[] {
  const { maxGapMs = 10_000, maxChunkMs = 600_000 } = options;
  const chunks: TimeRange[] = [];
  for (const region of regions) {
    const current = chunks.at(-1);
    if (current && region.startMs - current.endMs <= maxGapMs && region.endMs - current.startMs <= maxChunkMs) {
      current.endMs = region.endMs;
      continue;
    }
    for (let start = region.startMs; start < region.endMs; start += maxChunkMs) {
      chunks.push({ startMs: start, endMs: Math.min(start + maxChunkMs, region.endMs) });
    }
  }
  return chunks;
}

/** Cuts one chunk out of a track as small mono Ogg Opus, which every Whisper-style API accepts. */
export async function extractChunk(ffmpegPath: string, input: string, output: string, range: TimeRange): Promise<void> {
  await runFfmpeg(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', (range.startMs / 1000).toFixed(3),
    '-t', ((range.endMs - range.startMs) / 1000).toFixed(3),
    '-i', input,
    '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip',
    output,
  ]);
}
