import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { UserError } from '../errors.js';
import type { SessionManifest, StepName, StepState } from '../sessions/manifest.js';
import type { SessionStore } from '../sessions/store.js';
import { LOCK_FILE, PROCESSING_OUTPUTS } from './files.js';
import { acquireLock, SessionLockedError, type LockOptions, type SessionLock } from './lock.js';

export interface StepContext {
  /** The session being processed. Steps record their outputs on it; the runner saves it. */
  manifest: SessionManifest;
  logger: Logger;
  /** Absolute path of a file inside the session directory. */
  resolve(relative: string): string;
  /** Saves the manifest now, for steps that must not lose progress made part-way (e.g. IDs of things created in Notion). */
  checkpoint(): Promise<void>;
}

export interface PipelineStep {
  name: StepName;
  /** Steps whose output this one reads. A failed step blocks only the steps that need it. */
  needs?: StepName[];
  /** Must be safe to re-run: after a crash or a retry the step runs again from the start. */
  run(context: StepContext): Promise<void>;
  /** Undoes the step's external effects before a run that starts over (reset `all`). */
  reset?(context: StepContext): Promise<void>;
}

/** Called after every state change; `finished` is true once the run ends. */
export type PipelineListener = (manifest: SessionManifest, finished: boolean) => void | Promise<void>;

/**
 * What a run does with earlier results first: `failed` retries failed steps, `all` deletes
 * every output and cache and starts over.
 */
export type ResetMode = 'failed' | 'all';

export type RunOutcome = 'finished' | 'nothing-to-do' | 'not-recorded' | 'locked' | 'crashed';

export interface RunResult {
  outcome: RunOutcome;
  /** Who holds the session when the outcome is `locked`. */
  lockedBy?: string;
}

export interface PipelineDeps {
  store: SessionStore;
  steps: PipelineStep[];
  logger: Logger;
  onUpdate?: PipelineListener | undefined;
  /** Names this process in the session lock, e.g. "bot" or "process-session script". */
  lockLabel?: string;
  lockOptions?: LockOptions;
  now?: () => number;
}

/**
 * Runs the processing steps (mix, transcribe → summarize) for recorded sessions, one session
 * at a time. Progress lives in the manifest, so a job interrupted by a restart resumes where
 * it stopped. A failed step waits for a retry and blocks only the steps that need its output.
 * A lock file keeps two processes from working on the same session.
 */
export class Pipeline {
  private readonly store: SessionStore;
  private readonly steps: PipelineStep[];
  private readonly logger: Logger;
  private readonly onUpdate: PipelineListener | undefined;
  private readonly lockLabel: string;
  private readonly lockOptions: LockOptions | undefined;
  private readonly now: () => number;

  private readonly jobs = new Map<string, Promise<RunResult>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(deps: PipelineDeps) {
    this.store = deps.store;
    this.steps = deps.steps;
    this.logger = deps.logger;
    this.onUpdate = deps.onUpdate;
    this.lockLabel = deps.lockLabel ?? 'bot';
    this.lockOptions = deps.lockOptions;
    this.now = deps.now ?? Date.now;
  }

  get stepNames(): StepName[] {
    return this.steps.map((step) => step.name);
  }

  /** Queues a session; resolves when its run has ended. Queuing a session twice returns the same run. */
  enqueue(sessionId: string, reset?: ResetMode): Promise<RunResult> {
    const existing = this.jobs.get(sessionId);
    if (existing) return existing;

    const job = this.tail
      .then(() => this.process(sessionId, reset))
      .catch((error: unknown): RunResult => {
        this.logger.error('Processing crashed', { sessionId, error });
        return { outcome: 'crashed' };
      })
      .finally(() => this.jobs.delete(sessionId));
    this.jobs.set(sessionId, job);
    this.tail = job;
    return job;
  }

  isQueued(sessionId: string): boolean {
    return this.jobs.has(sessionId);
  }

  /**
   * Queues a re-run of the session's failed steps (and the ones waiting on them). Returns the
   * manifest as it will look when the run starts, for an immediate panel update.
   */
  async retry(sessionId: string): Promise<SessionManifest> {
    if (this.jobs.has(sessionId)) throw new UserError('This meeting is already being processed.');
    const manifest = await this.store.load(sessionId);
    const failed = Object.values(manifest.processing ?? {}).filter((state) => state.status === 'failed');
    if (failed.length === 0) throw new UserError('Nothing to retry: no processing step has failed.');
    resetFailed(manifest);
    void this.enqueue(sessionId, 'failed');
    return manifest;
  }

  /** Queues sessions whose processing was cut short by a restart. Call once at boot. */
  async resumeUnfinished(): Promise<void> {
    for (const manifest of await this.store.list()) {
      if (manifest.status !== 'recorded' || !manifest.processing) continue;
      if (this.steps.some((step) => this.isRunnable(manifest, step))) {
        this.logger.info('Resuming processing', { sessionId: manifest.id });
        void this.enqueue(manifest.id);
      }
    }
  }

  private async process(sessionId: string, reset: ResetMode | undefined): Promise<RunResult> {
    const log = this.logger.child({ sessionId });
    let lock: SessionLock;
    try {
      lock = await acquireLock(this.store.resolve(sessionId, LOCK_FILE), this.lockLabel, this.lockOptions);
    } catch (error) {
      if (!(error instanceof SessionLockedError)) throw error;
      log.warn('Not processing: the session is locked', { owner: error.owner });
      return { outcome: 'locked', lockedBy: error.owner };
    }
    try {
      return await this.processLocked(sessionId, reset, log);
    } finally {
      await lock.release();
    }
  }

  private async processLocked(sessionId: string, reset: ResetMode | undefined, log: Logger): Promise<RunResult> {
    const manifest = await this.store.load(sessionId);
    // Sessions from before mixing was a processing step end as `failed` when the mixdown failed.
    if (manifest.status === 'failed' && manifest.tracks.length > 0) {
      manifest.status = 'recorded';
      delete manifest.error;
    }
    if (manifest.status !== 'recorded') {
      log.warn('Not processing: the session is not recorded', { status: manifest.status });
      return { outcome: 'not-recorded' };
    }

    const context: StepContext = {
      manifest,
      logger: log,
      resolve: (relative) => path.join(this.store.sessionDir(sessionId), relative),
      checkpoint: () => this.save(manifest, false),
    };

    if (reset === 'all') {
      for (const step of this.steps) await step.reset?.(context);
      await this.clearOutputs(manifest);
    }
    if (reset === 'failed') resetFailed(manifest);
    const processing = (manifest.processing ??= {});
    for (const step of this.steps) processing[step.name] ??= { status: 'pending', attempts: 0 };

    // Steps are listed after the steps they need, so one pass runs everything that can run.
    let ran = false;
    for (const step of this.steps) {
      if (!this.isRunnable(manifest, step, false)) continue;
      ran = true;
      await this.runStep(step, processing[step.name] as StepState, context);
    }
    if (!ran && !reset) return { outcome: 'nothing-to-do' };
    await this.save(manifest, true);
    return { outcome: 'finished' };
  }

  private async runStep(step: PipelineStep, state: StepState, context: StepContext): Promise<void> {
    const log = context.logger;
    state.status = 'running';
    state.attempts += 1;
    state.startedAt = new Date(this.now()).toISOString();
    delete state.finishedAt;
    delete state.error;
    await this.save(context.manifest, false);
    log.info('Step started', { step: step.name, attempt: state.attempts });

    try {
      await step.run(context);
      state.status = 'done';
      log.info('Step done', { step: step.name, ms: this.now() - Date.parse(state.startedAt) });
    } catch (error) {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      log.error('Step failed', { step: step.name, error });
    }
    state.finishedAt = new Date(this.now()).toISOString();
    await this.save(context.manifest, false);
  }

  /**
   * Whether a step can run now: not done or failed, and every step it needs is done. With
   * `waitForPending`, a step whose needs are still pending counts too (they'll run first).
   */
  private isRunnable(manifest: SessionManifest, step: PipelineStep, waitForPending = true): boolean {
    const status = manifest.processing?.[step.name]?.status ?? 'pending';
    if (status === 'done' || status === 'failed') return false;
    const configured = this.stepNames;
    return (step.needs ?? [])
      .filter((need) => configured.includes(need))
      .every((need) => {
        const needStatus = manifest.processing?.[need]?.status ?? 'pending';
        if (needStatus === 'done') return true;
        const needStep = this.steps.find((s) => s.name === need);
        return waitForPending && needStatus !== 'failed' && needStep !== undefined && this.isRunnable(manifest, needStep);
      });
  }

  private async clearOutputs(manifest: SessionManifest): Promise<void> {
    for (const output of PROCESSING_OUTPUTS) {
      await rm(this.store.resolve(manifest.id, output), { recursive: true, force: true });
    }
    delete manifest.processing;
    delete manifest.mixedFile;
    delete manifest.transcriptFile;
    delete manifest.transcriptDataFile;
    delete manifest.summaryFile;
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

function resetFailed(manifest: SessionManifest): void {
  for (const state of Object.values(manifest.processing ?? {})) {
    if (state.status !== 'failed') continue;
    state.status = 'pending';
    delete state.error;
  }
}
