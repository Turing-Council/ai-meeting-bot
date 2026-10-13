import path from 'node:path';
import type { Logger } from '../logger.js';
import { UserError } from '../errors.js';
import type { SessionManifest, StepName, StepState } from '../sessions/manifest.js';
import type { SessionStore } from '../sessions/store.js';

export interface StepContext {
  /** The session being processed. Steps record their outputs on it; the runner saves it. */
  manifest: SessionManifest;
  logger: Logger;
  /** Absolute path of a file inside the session directory. */
  resolve(relative: string): string;
}

export interface PipelineStep {
  name: StepName;
  /** Must be safe to re-run: after a crash or a retry the step runs again from the start. */
  run(context: StepContext): Promise<void>;
}

/** Called after every state change; `finished` is true once the run ends (done or failed). */
export type PipelineListener = (manifest: SessionManifest, finished: boolean) => void | Promise<void>;

export interface PipelineDeps {
  store: SessionStore;
  steps: PipelineStep[];
  logger: Logger;
  onUpdate?: PipelineListener | undefined;
  now?: () => number;
}

/**
 * Runs the processing steps (transcribe → summarize) for recorded sessions, one session at
 * a time. Progress lives in the manifest, so a job interrupted by a restart resumes where it
 * stopped. A failed step stops the run until someone retries it.
 */
export class Pipeline {
  private readonly store: SessionStore;
  private readonly steps: PipelineStep[];
  private readonly logger: Logger;
  private readonly onUpdate: PipelineListener | undefined;
  private readonly now: () => number;

  private readonly jobs = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: PipelineDeps) {
    this.store = deps.store;
    this.steps = deps.steps;
    this.logger = deps.logger;
    this.onUpdate = deps.onUpdate;
    this.now = deps.now ?? Date.now;
  }

  /** False when no step is configured (no STT provider): sessions just stay `recorded`. */
  get enabled(): boolean {
    return this.steps.length > 0;
  }

  get stepNames(): StepName[] {
    return this.steps.map((step) => step.name);
  }

  /** Queues a session; resolves when its run has ended. Queuing a session twice returns the same run. */
  enqueue(sessionId: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const existing = this.jobs.get(sessionId);
    if (existing) return existing;

    const job = this.tail
      .then(() => this.process(sessionId))
      .catch((error: unknown) => this.logger.error('Processing crashed', { sessionId, error }))
      .finally(() => this.jobs.delete(sessionId));
    this.jobs.set(sessionId, job);
    this.tail = job;
    return job;
  }

  isQueued(sessionId: string): boolean {
    return this.jobs.has(sessionId);
  }

  /** Re-runs a session's failed step (and the ones after it). */
  async retry(sessionId: string): Promise<SessionManifest> {
    if (this.jobs.has(sessionId)) throw new UserError('This meeting is already being processed.');
    const manifest = await this.store.load(sessionId);
    const failed = Object.values(manifest.processing ?? {}).filter((state) => state.status === 'failed');
    if (failed.length === 0) throw new UserError('Nothing to retry: no processing step has failed.');
    for (const state of failed) {
      state.status = 'pending';
      delete state.error;
    }
    await this.store.save(manifest);
    void this.enqueue(sessionId);
    return manifest;
  }

  /** Queues sessions whose processing was cut short by a restart. Call once at boot. */
  async resumeUnfinished(): Promise<void> {
    if (!this.enabled) return;
    for (const manifest of await this.store.list()) {
      if (manifest.status !== 'recorded' || !manifest.processing) continue;
      const states = Object.values(manifest.processing);
      if (states.some((state) => state.status === 'pending' || state.status === 'running')) {
        this.logger.info('Resuming processing', { sessionId: manifest.id });
        void this.enqueue(manifest.id);
      }
    }
  }

  private async process(sessionId: string): Promise<void> {
    const log = this.logger.child({ sessionId });
    const manifest = await this.store.load(sessionId);
    if (manifest.status !== 'recorded') {
      log.warn('Not processing: the session is not recorded', { status: manifest.status });
      return;
    }

    const processing = (manifest.processing ??= {});
    for (const step of this.steps) processing[step.name] ??= { status: 'pending', attempts: 0 };
    const pending = this.steps.filter((step) => processing[step.name]?.status !== 'done');
    if (pending.length === 0) return;

    const context: StepContext = {
      manifest,
      logger: log,
      resolve: (relative) => path.join(this.store.sessionDir(sessionId), relative),
    };

    for (const step of pending) {
      const state = processing[step.name] as StepState;
      if (state.status === 'failed') break; // waits for a retry

      state.status = 'running';
      state.attempts += 1;
      state.startedAt = new Date(this.now()).toISOString();
      delete state.finishedAt;
      delete state.error;
      await this.save(manifest, false);
      log.info('Step started', { step: step.name, attempt: state.attempts });

      try {
        await step.run(context);
        state.status = 'done';
        state.finishedAt = new Date(this.now()).toISOString();
        log.info('Step done', { step: step.name, ms: this.now() - Date.parse(state.startedAt) });
      } catch (error) {
        state.status = 'failed';
        state.finishedAt = new Date(this.now()).toISOString();
        state.error = error instanceof Error ? error.message : String(error);
        log.error('Step failed', { step: step.name, error });
        break;
      }
    }
    await this.save(manifest, true);
  }

  private async save(manifest: SessionManifest, finished: boolean): Promise<void> {
    await this.store.save(manifest);
    try {
      await this.onUpdate?.(structuredClone(manifest), finished);
    } catch (error) {
      this.logger.warn('Processing update listener failed', { sessionId: manifest.id, error });
    }
  }
}
