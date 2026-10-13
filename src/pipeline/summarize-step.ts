import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { formatOffset } from '../bot/format.js';
import { Summary } from '../summarize/summary.js';
import type { Summarizer, SummaryCache } from '../summarize/summarizer.js';
import { Transcript, transcriptLines } from '../transcript/transcript.js';
import { LLM_WORK_DIR, readJsonFile, SUMMARY_FILE, TRANSCRIPT_DATA_FILE, writeJsonFile } from './files.js';
import type { PipelineStep, StepContext } from './runner.js';

/** Summarizes `transcript.json` (plus the meeting's bookmarks) into `summary.json`. */
export function summarizeStep({ summarizer }: { summarizer: Summarizer }): PipelineStep {
  return {
    name: 'summarize',
    async run({ manifest, resolve }: StepContext) {
      const transcriptFile = resolve(manifest.transcriptDataFile ?? TRANSCRIPT_DATA_FILE);
      const transcript = Transcript.parse(JSON.parse(await readFile(transcriptFile, 'utf8')));

      const workDir = resolve(LLM_WORK_DIR);
      await mkdir(workDir, { recursive: true });
      const cache: SummaryCache = {
        get: (key) => readJsonFile(path.join(workDir, `${key}.json`), Summary),
        set: (key, summary) => writeJsonFile(path.join(workDir, `${key}.json`), summary),
      };

      const summary = await summarizer.summarize(
        {
          title: manifest.title,
          type: manifest.type,
          startedAt: manifest.startedAt,
          participants: manifest.participants.map((p) => p.name),
          bookmarks: manifest.bookmarks.map((b) => `[${formatOffset(b.atMs)}] ${b.text} (by ${b.by.name})`),
        },
        transcriptLines(transcript.turns),
        cache,
      );
      await writeJsonFile(resolve(SUMMARY_FILE), summary);
      manifest.summaryFile = SUMMARY_FILE;
    },
  };
}
