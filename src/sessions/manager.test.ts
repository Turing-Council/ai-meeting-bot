import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config.js';
import { silentLogger } from '../logger.js';
import type { SessionManifest } from './manifest.js';
import { SessionManager } from './manager.js';
import { SessionStore } from './store.js';

function manifest(id: string, overrides: Partial<SessionManifest> = {}): SessionManifest {
  return {
    version: 1,
    id,
    title: 'Weekly sync',
    trigger: 'manual',
    status: 'recording',
    guildId: 'g1',
    voiceChannelId: 'v1',
    voiceChannelName: 'General',
    startedBy: { id: 'u1', name: 'Alice' },
    startedAt: '2026-10-13T14:00:00.000Z',
    participants: [{ id: 'u1', name: 'Alice' }],
    tracks: [],
    pauses: [],
    bookmarks: [],
    ...overrides,
  };
}

describe('SessionManager.recoverInterrupted', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tvb-mgr-'));
    store = new SessionStore(root, silentLogger);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // `true`/`false` stand in for ffmpeg: success or failure without needing it installed.
  const managerWith = (ffmpegPath: string) =>
    new SessionManager({
      client: {} as Client,
      store,
      logger: silentLogger,
      config: { ffmpegPath, emptyChannelTimeoutMs: 120_000 } as Config,
    });

  async function writeTrack(id: string, userId: string, modifiedAt: Date) {
    const file = store.resolve(id, `tracks/${userId}.ogg`);
    await writeFile(file, Buffer.from('OggS fake audio'));
    await utimes(file, modifiedAt, modifiedAt);
  }

  it('finishes a crashed session: adopts unlisted tracks, closes pauses, mixes', async () => {
    await store.create(
      manifest('s1', {
        status: 'paused',
        tracks: [{ userId: 'u1', file: 'tracks/u1.ogg' }],
        pauses: [{ startMs: 60_000 }],
      }),
    );
    await writeTrack('s1', 'u1', new Date('2026-10-13T14:05:00.000Z'));
    await writeTrack('s1', 'u2', new Date('2026-10-13T14:10:00.000Z')); // created right before the crash

    await managerWith('true').recoverInterrupted();
    const recovered = await store.load('s1');

    expect(recovered.status).toBe('recorded');
    expect(recovered.interrupted).toBe(true);
    expect(recovered.tracks.map((t) => t.userId).sort()).toEqual(['u1', 'u2']);
    expect(recovered.endedAt).toBe('2026-10-13T14:10:00.000Z'); // last audio written
    expect(recovered.durationMs).toBe(600_000);
    expect(recovered.pauses).toEqual([{ startMs: 60_000, endMs: 600_000 }]);
    expect(recovered.mixedFile).toBe('mixed.ogg');
  });

  it('keeps the original end time of a session stopped by a graceful shutdown', async () => {
    await store.create(
      manifest('s1', {
        status: 'finalizing',
        endedAt: '2026-10-13T14:30:00.000Z',
        endReason: 'bot shutting down',
        durationMs: 1_800_000,
        tracks: [{ userId: 'u1', file: 'tracks/u1.ogg' }],
      }),
    );
    await writeTrack('s1', 'u1', new Date('2026-10-13T14:29:59.000Z'));

    await managerWith('true').recoverInterrupted();
    const recovered = await store.load('s1');
    expect(recovered.status).toBe('recorded');
    expect(recovered.interrupted).toBeUndefined();
    expect(recovered.endReason).toBe('bot shutting down');
    expect(recovered.durationMs).toBe(1_800_000);
  });

  it('marks the session failed but keeps the tracks when mixing fails', async () => {
    await store.create(manifest('s1', { tracks: [{ userId: 'u1', file: 'tracks/u1.ogg' }] }));
    await writeTrack('s1', 'u1', new Date('2026-10-13T14:05:00.000Z'));

    await managerWith('false').recoverInterrupted();
    const recovered = await store.load('s1');
    expect(recovered.status).toBe('failed');
    expect(recovered.error).toMatch(/ffmpeg exited with code 1/);
    expect(recovered.tracks).toHaveLength(1);
    expect(recovered.mixedFile).toBeUndefined();
  });

  it('records a session where nobody spoke without mixing', async () => {
    await store.create(manifest('s1'));
    await managerWith('false').recoverInterrupted(); // would fail if it tried to mix
    const recovered = await store.load('s1');
    expect(recovered.status).toBe('recorded');
    expect(recovered.durationMs).toBe(0);
  });

  it('leaves finished sessions alone', async () => {
    const done = manifest('s1', { status: 'recorded', endedAt: '2026-10-13T15:00:00.000Z', durationMs: 3_600_000 });
    await store.create(done);
    await managerWith('false').recoverInterrupted();
    expect(await store.load('s1')).toEqual(done);
  });
});
