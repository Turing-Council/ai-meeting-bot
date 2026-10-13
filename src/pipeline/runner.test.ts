import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserError } from '../errors.js';
import { silentLogger } from '../logger.js';
import type { SessionManifest } from '../sessions/manifest.js';
import { SessionStore } from '../sessions/store.js';
import { mapLimit } from './concurrency.js';
import { LOCK_FILE } from './files.js';
import { acquireLock } from './lock.js';
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

  type Name = 'mix' | 'transcribe' | 'summarize';
  /** The real step layout (summarize needs transcribe); `failures` makes a step throw that many times. */
  function steps(failures: Partial<Record<Name, number>> = {}): PipelineStep[] {
    return (['mix', 'transcribe', 'summarize'] as const).map((name) => ({
      name,
      ...(name === 'summarize' ? { needs: ['transcribe' as const] } : {}),
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
  const statuses = (m: SessionManifest) => Object.fromEntries(Object.entries(m.processing ?? {}).map(([k, v]) => [k, v.status]));

  it('runs the steps in order, saves outputs and reports progress', async () => {
    await store.create(manifest('s1'));
    const updates: string[] = [];
    const pipeline = new Pipeline({
      store,
      steps: steps(),
      logger: silentLogger,
      onUpdate: (m, finished) => {
        if (finished) updates.push(`finished ${JSON.stringify(statuses(m))}`);
      },
    });

    expect(await pipeline.enqueue('s1')).toEqual({ outcome: 'finished' });
    const done = await store.load('s1');
    expect(log).toEqual(['mix:s1', 'transcribe:s1', 'summarize:s1']);
    expect(statuses(done)).toEqual({ mix: 'done', transcribe: 'done', summarize: 'done' });
    expect(done.transcriptFile).toBe('transcript.md');
    expect(updates).toEqual(['finished {"mix":"done","transcribe":"done","summarize":"done"}']);

    expect(await pipeline.enqueue('s1')).toEqual({ outcome: 'nothing-to-do' });
    expect(log).toHaveLength(3);
  });

  it('a failed step blocks only the steps that need it', async () => {
    await store.create(manifest('s1'));
    await store.create(manifest('s2'));
    const pipeline = new Pipeline({ store, steps: steps({ mix: 1, transcribe: 1 }), logger: silentLogger });

    await pipeline.enqueue('s1'); // mix and transcribe fail; summarize waits for transcribe
    expect(log).toEqual(['mix:s1', 'transcribe:s1']);
    expect(statuses(await store.load('s1'))).toEqual({ mix: 'failed', transcribe: 'failed', summarize: 'pending' });
    expect((await store.load('s1')).processing?.mix?.error).toBe('mix broke');

    await pipeline.enqueue('s2'); // failures used up: a failed mix doesn't stop transcription elsewhere either
    expect(statuses(await store.load('s2'))).toEqual({ mix: 'done', transcribe: 'done', summarize: 'done' });
  });

  it('waits for an explicit retry, then re-runs the failed steps and what they blocked', async () => {
    await store.create(manifest('s1'));
    const pipeline = new Pipeline({ store, steps: steps({ transcribe: 1 }), logger: silentLogger });
    await pipeline.enqueue('s1');
    expect(await pipeline.enqueue('s1')).toEqual({ outcome: 'nothing-to-do' });

    const shown = await pipeline.retry('s1');
    expect(statuses(shown)).toEqual({ mix: 'done', transcribe: 'pending', summarize: 'pending' });
    await pipeline.enqueue('s1'); // joins the retry's run
    const state = await store.load('s1');
    expect(log).toEqual(['mix:s1', 'transcribe:s1', 'transcribe:s1', 'summarize:s1']);
    expect(state.processing?.transcribe).toMatchObject({ status: 'done', attempts: 2 });
    expect(state.processing?.transcribe?.error).toBeUndefined();
    await expect(pipeline.retry('s1')).rejects.toThrow(UserError);
  });

  it('resumes runs interrupted by a restart, but not blocked or never-started ones', async () => {
    const done = { status: 'done' as const, attempts: 1 };
    await store.create(manifest('s1', { processing: { mix: done, transcribe: done, summarize: { status: 'running', attempts: 1 } } }));
    await store.create(manifest('s2')); // recorded before processing existed
    await store.create(
      manifest('s3', { processing: { mix: done, transcribe: { status: 'failed', attempts: 1 }, summarize: { status: 'pending', attempts: 0 } } }),
    );
    const pipeline = new Pipeline({ store, steps: steps(), logger: silentLogger });

    await pipeline.resumeUnfinished();
    expect(pipeline.isQueued('s1')).toBe(true);
    expect(pipeline.isQueued('s2')).toBe(false);
    expect(pipeline.isQueued('s3')).toBe(false);
    await pipeline.enqueue('s1');
    expect(log).toEqual(['summarize:s1']);
  });

  it('processes one session at a time, in order', async () => {
    await store.create(manifest('s1'));
    await store.create(manifest('s2'));
    const pipeline = new Pipeline({ store, steps: steps().slice(0, 1), logger: silentLogger });
    await Promise.all([pipeline.enqueue('s1'), pipeline.enqueue('s2'), pipeline.enqueue('s1')]);
    expect(log).toEqual(['mix:s1', 'mix:s2']);
  });

  it('skips a session another process holds, and takes over a stale lock', async () => {
    await store.create(manifest('s1'));
    const script = await acquireLock(store.resolve('s1', LOCK_FILE), 'process-session script');
    const pipeline = new Pipeline({ store, steps: steps(), logger: silentLogger });

    const result = await pipeline.enqueue('s1');
    expect(result.outcome).toBe('locked');
    expect(result.lockedBy).toMatch(/^process-session script \(pid \d+ on .+\)$/);
    expect(log).toEqual([]);

    // The holder dies without releasing: once its heartbeat is old, the lock is taken over.
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(store.resolve('s1', LOCK_FILE), old, old);
    expect((await pipeline.enqueue('s1')).outcome).toBe('finished');
    await expect(stat(store.resolve('s1', LOCK_FILE))).rejects.toThrow(); // released after the run
    await script.release();
  });

  it('starts over with reset "all", deleting earlier outputs', async () => {
    await store.create(manifest('s1'));
    const pipeline = new Pipeline({ store, steps: steps(), logger: silentLogger });
    await pipeline.enqueue('s1');
    await writeFile(store.resolve('s1', 'summary.json'), '{}');
    await mkdir(store.resolve('s1', 'work/stt'), { recursive: true });

    await pipeline.enqueue('s1', 'all');
    expect(log).toHaveLength(6);
    await expect(stat(store.resolve('s1', 'summary.json'))).rejects.toThrow();
    await expect(stat(store.resolve('s1', 'work'))).rejects.toThrow();
    expect(statuses(await store.load('s1'))).toEqual({ mix: 'done', transcribe: 'done', summarize: 'done' });
  });

  it('processes sessions whose mixdown failed before mixing was a processing step', async () => {
    await store.create(manifest('s1', { status: 'failed', error: 'ffmpeg exited with code 1' }));
    await store.create(manifest('s2', { status: 'recording' }));
    const pipeline = new Pipeline({ store, steps: steps(), logger: silentLogger });

    expect((await pipeline.enqueue('s1')).outcome).toBe('finished');
    const legacy = await store.load('s1');
    expect(legacy.status).toBe('recorded');
    expect(legacy.error).toBeUndefined();
    expect((await pipeline.enqueue('s2')).outcome).toBe('not-recorded');
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
