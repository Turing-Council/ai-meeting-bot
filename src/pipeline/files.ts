import { readFile } from 'node:fs/promises';
import type { z } from 'zod';
import { writeFileAtomic } from '../sessions/store.js';

/** Output files of the processing steps, relative to the session directory. */
export const MIXED_FILE = 'mixed.ogg';
export const TRANSCRIPT_DATA_FILE = 'transcript.json';
export const TRANSCRIPT_FILE = 'transcript.md';
export const SUMMARY_FILE = 'summary.json';
/** Per-chunk caches, so a retried or resumed step doesn't pay for the same API calls twice. */
export const STT_WORK_DIR = 'work/stt';
export const LLM_WORK_DIR = 'work/llm';
/** Held while a session is being processed (see lock.ts). */
export const LOCK_FILE = 'processing.lock';

/** Everything processing produces; deleted when a session is reprocessed from scratch. */
export const PROCESSING_OUTPUTS = [MIXED_FILE, TRANSCRIPT_DATA_FILE, TRANSCRIPT_FILE, SUMMARY_FILE, 'work'];

/** Reads and validates a JSON file; undefined if it doesn't exist or isn't valid. */
export async function readJsonFile<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T> | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
