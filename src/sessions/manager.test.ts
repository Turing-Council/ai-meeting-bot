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

  let handedOver: string[];
  const manager = () => {
    handedOver = [];
    return new SessionManager({
      client: {} as Client,
      store,
      logger: silentLogger,
      config: { emptyChannelTimeoutMs: 120_000 } as Config,
      onRecorded: (m) => handedOver.push(m.id),
    });
  };

  async function writeTrack(id: string, userId: string, modifiedAt: Date) {
    const file = store.resolve(id, `tracks/${userId}.ogg`);
    await writeFile(file, Buffer.from('OggS fake audio'));
    await utimes(file, modifiedAt, modifiedAt);
  }

  it('finishes a crashed session (adopts unlisted tracks, closes pauses) and hands it to processing', async () => {
    await store.create(
      manifest('s1', {
        status: 'paused',
        tracks: [{ userId: 'u1', file: 'tracks/u1.ogg' }],
        pauses: [{ startMs: 60_000 }],
      }),
    );
    await writeTrack('s1', 'u1', new Date('2026-10-13T14:05:00.000Z'));
    await writeTrack('s1', 'u2', new Date('2026-10-13T14:10:00.000Z')); // created right before the crash

    await manager().recoverInterrupted();
    const recovered = await store.load('s1');

    expect(handedOver).toEqual(['s1']);
    expect(recovered.status).toBe('recorded');
    expect(recovered.interrupted).toBe(true);
    expect(recovered.tracks.map((t) => t.userId).sort()).toEqual(['u1', 'u2']);
    expect(recovered.endedAt).toBe('2026-10-13T14:10:00.000Z'); // last audio written
    expect(recovered.durationMs).toBe(600_000);
    expect(recovered.pauses).toEqual([{ startMs: 60_000, endMs: 600_000 }]);
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

    await manager().recoverInterrupted();
    const recovered = await store.load('s1');
    expect(recovered.status).toBe('recorded');
    expect(recovered.interrupted).toBeUndefined();
    expect(recovered.endReason).toBe('bot shutting down');
    expect(recovered.durationMs).toBe(1_800_000);
  });

  it('records a session where nobody spoke without processing it', async () => {
    await store.create(manifest('s1'));
    await manager().recoverInterrupted();
    const recovered = await store.load('s1');
    expect(recovered.status).toBe('recorded');
    expect(recovered.durationMs).toBe(0);
    expect(handedOver).toEqual([]);
  });

  it('leaves finished sessions alone', async () => {
    const done = manifest('s1', { status: 'recorded', endedAt: '2026-10-13T15:00:00.000Z', durationMs: 3_600_000 });
    await store.create(done);
    await manager().recoverInterrupted();
    expect(await store.load('s1')).toEqual(done);
    expect(handedOver).toEqual([]);
  });
});
