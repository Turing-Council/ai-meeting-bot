import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import type { SessionManifest } from '../sessions/manifest.js';
import { FakeNotionApi } from '../test-utils/fake-notion.js';
import { NotionPublisher } from './publisher.js';
import { NotionSettings } from './settings.js';
import { setupNotion } from './setup.js';

const manifest: SessionManifest = {
  version: 1,
  id: 's1',
  title: 'Weekly sync',
  trigger: 'manual',
  status: 'recording',
  guildId: 'g',
  voiceChannelId: 'v',
  voiceChannelName: 'General',
  startedBy: { id: 'u1', name: 'Alice' },
  startedAt: '2026-10-13T14:00:00.000Z',
  participants: [{ id: 'u1', name: 'Alice' }],
  tracks: [],
  pauses: [],
  bookmarks: [],
};

describe('NotionPublisher', () => {
  let dir: string;
  let api: FakeNotionApi;
  let settings: NotionSettings;
  let publisher: NotionPublisher;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-pub-'));
    api = new FakeNotionApi();
    settings = new NotionSettings(path.join(dir, 'notion.json'));
    publisher = new NotionPublisher(api, settings, silentLogger);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the page at start in the Meetings data source and hands it to the session', async () => {
    const { setup } = await setupNotion(api, settings, 'parent', silentLogger);
    const attached: string[] = [];
    await publisher.startMeeting(manifest, async (page) => {
      attached.push(page.id);
      return true;
    });

    const [pageId] = attached;
    const page = api.pages.get(pageId!);
    expect(page?.params.parent).toEqual({ type: 'data_source_id', data_source_id: setup.meetings.dataSourceId });
    expect(page?.properties.Status).toEqual({ status: { name: 'Recording' } });
  });

  it('trashes the page if the meeting already ended, and never throws', async () => {
    await setupNotion(api, settings, 'parent', silentLogger);
    await publisher.startMeeting(manifest, async () => false);
    expect([...api.pages.values()].map((p) => p.trashed)).toEqual([true]);

    api.failOn('createPage');
    await expect(publisher.startMeeting(manifest, async () => true)).resolves.toBeUndefined();
  });

  it('does nothing before setup', async () => {
    await publisher.startMeeting(manifest, async () => true);
    expect(api.calls).toEqual([]);
  });

  it('mirrors processing in the Status, skipping repeats', async () => {
    await setupNotion(api, settings, 'parent', silentLogger);
    const page = await publisher.createMeetingPage(manifest, 'Recording');
    const session: SessionManifest = { ...manifest, status: 'recorded', notion: { pageId: page.id, pageUrl: page.url, bodyBlockIds: [], actionItemIds: [] } };
    const listener = publisher.statusListener();

    await listener(session, false);
    await listener(session, false);
    expect(api.pages.get(page.id)?.properties.Status).toEqual({ status: { name: 'Processing' } });
    expect(api.calls.filter((c) => c === 'updatePage')).toHaveLength(1);

    await listener({ ...session, processing: { mix: { status: 'failed', attempts: 1 } } }, true);
    expect(api.pages.get(page.id)?.properties.Status).toEqual({ status: { name: 'Failed' } });

    await listener({ ...session, processing: { mix: { status: 'done', attempts: 2 } } }, true); // Done comes from publishing
    expect(api.pages.get(page.id)?.properties.Status).toEqual({ status: { name: 'Failed' } });
  });
});
