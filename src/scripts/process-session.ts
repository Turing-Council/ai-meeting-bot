/**
 * Runs the processing pipeline (transcribe → summarize) on a recorded session, without Discord.
 *
 *   npm run process -- <sessionId>            resume or retry a session
 *   npm run process -- <sessionId> --force    start over: delete outputs and caches first
 *   npm run process -- --list                 list sessions and their processing state
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { LLM_WORK_DIR, STT_WORK_DIR, SUMMARY_FILE, TRANSCRIPT_DATA_FILE, TRANSCRIPT_FILE } from '../pipeline/files.js';
import { createPipeline, loadSummary } from '../pipeline/index.js';
import { SessionStore } from '../sessions/store.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig(process.env, { requireDiscord: false });
  const logger = createLogger(config.logLevel);
  const store = new SessionStore(path.resolve(config.dataDir, 'sessions'), logger);

  if (args.includes('--list') || args.length === 0) {
    for (const s of await store.list()) {
      const steps = Object.entries(s.processing ?? {}).map(([name, state]) => `${name}=${state.status}`);
      console.log(`${s.id}  ${s.status.padEnd(10)} ${steps.join(' ').padEnd(34)} ${s.title}`);
    }
    if (args.length === 0) console.log('\nUsage: npm run process -- <sessionId> [--force]');
    return;
  }

  const sessionId = args.find((arg) => !arg.startsWith('--'));
  if (!sessionId) throw new Error('Missing session ID');
  const pipeline = createPipeline(config, store, logger);
  if (!pipeline.enabled) throw new Error('No speech-to-text provider is configured (set STT_PROVIDER).');

  const manifest = await store.load(sessionId);
  if (args.includes('--force')) {
    for (const file of [TRANSCRIPT_DATA_FILE, TRANSCRIPT_FILE, SUMMARY_FILE, STT_WORK_DIR, LLM_WORK_DIR]) {
      await rm(store.resolve(sessionId, file), { recursive: true, force: true });
    }
    delete manifest.processing;
    delete manifest.transcriptFile;
    delete manifest.transcriptDataFile;
    delete manifest.summaryFile;
  } else {
    // Resuming by hand also retries failed steps.
    for (const state of Object.values(manifest.processing ?? {})) {
      if (state.status === 'failed') state.status = 'pending';
    }
  }
  await store.save(manifest);

  await pipeline.enqueue(sessionId);
  const result = await store.load(sessionId);
  console.log(JSON.stringify(result.processing, null, 2));
  if (result.transcriptFile) console.log(`Transcript: ${store.resolve(sessionId, result.transcriptFile)}`);
  const summary = await loadSummary(store, result);
  if (summary) console.log(`Summary:    ${store.resolve(sessionId, result.summaryFile ?? SUMMARY_FILE)}\n\nTL;DR: ${summary.tldr}`);
  const failed = Object.values(result.processing ?? {}).some((state) => state.status === 'failed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
