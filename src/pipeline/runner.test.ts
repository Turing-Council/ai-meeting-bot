import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserError } from '../errors.js';
import { silentLogger } from '../logger.js';
import type { SessionManifest } from '../sessions/manifest.js';
import { SessionStore } from '../sessions/store.js';
import { mapLimit } from './concurrency.js';
import { Pipeline, type PipelineStep } from './runner.js';

function manifest(id: string, overrides: Partial<SessionManifest> = {}): SessionManifest {
  return {
    version: 1,
    id,
    title: 'Weekly sync',
    trigger: 'manual',
    status: 'recorded',
    guildId: 'g1',
    voiceChannelId: 'v1',
    voiceChannelName: 'General',
    startedBy: { id: 'u1', name: 'Alice' },
    startedAt: '2026-10-13T14:00:00.000Z',
    participants: [{ id: 'u1', name: 'Alice' }],
    tracks: [{ userId: 'u1', file: 'tracks/u1.ogg' }],
    pauses: [],
    bookmarks: [],
    ...overrides,
  };
}

describe('Pipeline', () => {
  let root: string;
  let store: SessionStore;
  let log: string[];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tvb-pipe-'));
    store = new SessionStore(root, silentLogger);
    log = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Steps that record their runs; `failures` makes a step throw that many times. */
  function steps(failures: Partial<Record<'transcribe' | 'summarize', number>> = {}): PipelineStep[] {
    return (['transcribe', 'summarize'] as const).map((name) => ({
      name,
      run: async ({ manifest: m }) => {
        log.push(`${name}:${m.id}`);
        if ((failures[name] ?? 0) > 0) {
          failures[name] = (failures[name] ?? 0) - 1;
          throw new Error(`${name} broke`);
        }
        if (name === 'transcribe') m.transcriptFile = 'transcript.md';
      },
    }));
  }

  it('runs the steps in order, saves outputs and reports progress', async () => {
    await store.create(manifest('s1'));
    const updates: string[] = [];
    const pipeline = new Pipeline({
      store,
      steps: steps(),
      logger: silentLogger,
      onUpdate: (m, finished) => {
        updates.push(`${m.processing?.transcribe?.status}/${m.processing?.summarize?.status}${finished ? ' (finished)' : ''}`);
      },
    });

    await pipeline.enqueue('s1');
    const done = await store.load('s1');
    expect(log).toEqual(['transcribe:s1', 'summarize:s1']);
    expect(done.processing?.transcribe).toMatchObject({ status: 'done', attempts: 1 });
    expect(done.processing?.summarize).toMatchObject({ status: 'done', attempts: 1 });
    expect(done.transcriptFile).toBe('transcript.md');
    expect(updates).toEqual(['running/pending', 'done/running', 'done/done (finished)']);

    await pipeline.enqueue('s1'); // already done: nothing runs
    expect(log).toHaveLength(2);
  });

  it('stops at a failed step and continues from it on retry', async () => {
    await store.create(manifest('s1'));
    const pipeline = new Pipeline({ store, steps: steps({ summarize: 1 }), logger: silentLogger });

    await pipeline.enqueue('s1');
    let state = await store.load('s1');
    expect(state.processing?.transcribe?.status).toBe('done');
    expect(state.processing?.summarize).toMatchObject({ status: 'failed', attempts: 1, error: 'summarize broke' });

    await pipeline.enqueue('s1'); // a failed step waits for an explicit retry
    expect(log).toEqual(['transcribe:s1', 'summarize:s1']);

    await pipeline.retry('s1');
    await pipeline.enqueue('s1'); // joins the retry's run
    state = await store.load('s1');
    expect(log).toEqual(['transcribe:s1', 'summarize:s1', 'summarize:s1']);
    expect(state.processing?.summarize).toMatchObject({ status: 'done', attempts: 2 });
    expect(state.processing?.summarize?.error).toBeUndefined();
    await expect(pipeline.retry('s1')).rejects.toThrow(UserError);
  });

  it('resumes steps interrupted by a restart, and ignores sessions it never started', async () => {
    await store.create(
      manifest('s1', { processing: { transcribe: { status: 'done', attempts: 1 }, summarize: { status: 'running', attempts: 1 } } }),
    );
    await store.create(manifest('s2')); // recorded before processing existed
    await store.create(manifest('s3', { status: 'recording', processing: { transcribe: { status: 'pending', attempts: 0 } } }));
    const pipeline = new Pipeline({ store, steps: steps(), logger: silentLogger });

    await pipeline.resumeUnfinished();
    await pipeline.enqueue('s1');
    expect(log).toEqual(['summarize:s1']);
    expect((await store.load('s1')).processing?.summarize).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('processes one session at a time, in order', async () => {
    await store.create(manifest('s1'));
    await store.create(manifest('s2'));
    const pipeline = new Pipeline({ store, steps: steps(), logger: silentLogger });
    await Promise.all([pipeline.enqueue('s1'), pipeline.enqueue('s2'), pipeline.enqueue('s1')]);
    expect(log).toEqual(['transcribe:s1', 'summarize:s1', 'transcribe:s2', 'summarize:s2']);
  });

  it('only runs the configured steps and is disabled without any', async () => {
    await store.create(manifest('s1'));
    const transcribeOnly = new Pipeline({ store, steps: steps().slice(0, 1), logger: silentLogger });
    await transcribeOnly.enqueue('s1');
    expect((await store.load('s1')).processing).toEqual({ transcribe: expect.objectContaining({ status: 'done' }) });

    const off = new Pipeline({ store, steps: [], logger: silentLogger });
    expect(off.enabled).toBe(false);
    await store.create(manifest('s2'));
    await off.enqueue('s2');
    expect((await store.load('s2')).processing).toBeUndefined();
  });
});

describe('mapLimit', () => {
  it('keeps order and respects the limit', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([30, 10, 20, 5], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('stops starting new work after a failure', async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});
