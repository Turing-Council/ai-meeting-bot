import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { createSessionId, type SessionManifest } from './manifest.js';
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

describe('SessionStore', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'tvb-store-'));
    store = new SessionStore(root, silentLogger);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the session directory with a tracks folder and round-trips the manifest', async () => {
    await store.create(manifest('s1'));
    expect((await stat(path.join(root, 's1', 'tracks'))).isDirectory()).toBe(true);
    expect(await store.load('s1')).toEqual(manifest('s1'));
  });

  it('save() replaces the manifest atomically and leaves no temp files', async () => {
    await store.create(manifest('s1'));
    await store.save(manifest('s1', { status: 'recorded', durationMs: 1234 }));
    expect((await store.load('s1')).status).toBe('recorded');
    expect(await readdir(path.join(root, 's1'))).toEqual(['manifest.json', 'tracks']);
  });

  it('rejects invalid manifests instead of writing them', async () => {
    await store.create(manifest('s1'));
    await expect(store.save({ ...manifest('s1'), status: 'nope' } as never)).rejects.toThrow();
    expect((await store.load('s1')).status).toBe('recording');
  });

  it('lists sessions oldest first and skips unreadable ones', async () => {
    await store.create(manifest('20261013-120000-bbbb'));
    await store.create(manifest('20261012-090000-aaaa'));
    await mkdir(path.join(root, 'broken'));
    await writeFile(path.join(root, 'broken', 'manifest.json'), '{not json');

    const ids = (await store.list()).map((m) => m.id);
    expect(ids).toEqual(['20261012-090000-aaaa', '20261013-120000-bbbb']);
  });

  it('list() returns [] when the data directory does not exist yet', async () => {
    expect(await new SessionStore(path.join(root, 'missing'), silentLogger).list()).toEqual([]);
  });
});

describe('createSessionId', () => {
  it('is a sortable UTC timestamp plus a short random suffix', () => {
    const id = createSessionId(new Date('2026-10-13T14:03:12Z'), () => 0.5);
    expect(id).toMatch(/^20261013-140312-[0-9a-z]{4}$/);
  });
});
