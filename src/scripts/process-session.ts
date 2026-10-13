/**
 * Runs the processing pipeline (mix, transcribe → summarize) on a recorded session, without
 * Discord. Safe to use while the bot runs: a session lock keeps them from overlapping.
 *
 *   npm run process -- <sessionId>            resume, retrying failed steps
 *   npm run process -- <sessionId> --force    start over: delete outputs and caches first
 *   npm run process -- --list                 list sessions and their processing state
 */
import path from 'node:path';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { SUMMARY_FILE } from '../pipeline/files.js';
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
      console.log(`${s.id}  ${s.status.padEnd(10)} ${steps.join(' ').padEnd(44)} ${s.title}`);
    }
    if (args.length === 0) console.log('\nUsage: npm run process -- <sessionId> [--force]');
    return;
  }

  const sessionId = args.find((arg) => !arg.startsWith('--'));
  if (!sessionId) throw new Error('Missing session ID');
  const pipeline = createPipeline(config, store, logger, { lockLabel: 'process-session script' });
  const { outcome, lockedBy } = await pipeline.enqueue(sessionId, args.includes('--force') ? 'all' : 'failed');

  if (outcome === 'locked') throw new Error(`Session ${sessionId} is being processed by ${lockedBy ?? 'another process'}; try again later.`);
  if (outcome === 'not-recorded') throw new Error(`Session ${sessionId} has no finished recording to process.`);
  if (outcome === 'crashed') throw new Error('Processing crashed; see the log above.');

  const result = await store.load(sessionId);
  console.log(JSON.stringify(result.processing, null, 2));
  if (result.mixedFile) console.log(`Audio:      ${store.resolve(sessionId, result.mixedFile)}`);
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
