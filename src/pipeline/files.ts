import { readFile } from 'node:fs/promises';
import type { z } from 'zod';
import { writeFileAtomic } from '../sessions/store.js';

/** Output files of the processing steps, relative to the session directory. */
export const TRANSCRIPT_DATA_FILE = 'transcript.json';
export const TRANSCRIPT_FILE = 'transcript.md';
export const SUMMARY_FILE = 'summary.json';
/** Per-chunk caches, so a retried or resumed step doesn't pay for the same API calls twice. */
export const STT_WORK_DIR = 'work/stt';
export const LLM_WORK_DIR = 'work/llm';

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
