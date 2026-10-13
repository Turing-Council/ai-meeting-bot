import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { SessionManifest } from '../sessions/manifest.js';
import type { SessionStore } from '../sessions/store.js';
import { createSttProvider } from '../stt/index.js';
import { createChatModel } from '../summarize/index.js';
import { Summarizer } from '../summarize/summarizer.js';
import { Summary } from '../summarize/summary.js';
import { readJsonFile, SUMMARY_FILE } from './files.js';
import { Pipeline, type PipelineListener, type PipelineStep } from './runner.js';
import { summarizeStep } from './summarize-step.js';
import { transcribeStep } from './transcribe-step.js';

export { Pipeline } from './runner.js';

/**
 * Builds the pipeline from config: transcribe needs an STT provider, summarize also needs an
 * LLM. With no STT provider there are no steps and sessions simply stay `recorded`.
 */
export function createPipeline(
  config: Config,
  store: SessionStore,
  logger: Logger,
  onUpdate?: PipelineListener,
): Pipeline {
  const steps: PipelineStep[] = [];
  const stt = createSttProvider(config.stt);
  if (stt) {
    steps.push(transcribeStep({ stt, ffmpegPath: config.ffmpegPath }));
    const model = createChatModel(config.llm);
    if (model && config.llm.provider !== 'none') {
      const summarizer = new Summarizer({ model, chunkChars: config.llm.chunkChars, logger });
      steps.push(summarizeStep({ summarizer }));
    }
  }
  return new Pipeline({ store, steps, logger, onUpdate });
}

/** The session's summary, if the summarize step has produced one. */
export function loadSummary(store: SessionStore, manifest: SessionManifest): Promise<Summary | undefined> {
  return readJsonFile(store.resolve(manifest.id, manifest.summaryFile ?? SUMMARY_FILE), Summary);
}
