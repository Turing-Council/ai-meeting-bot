import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APIErrorCode } from '@notionhq/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { FakeNotionApi, notionError } from '../test-utils/fake-notion.js';
import { NotionSettings } from './settings.js';
import { describeSetupError, setupNotion } from './setup.js';

describe('setupNotion', () => {
  let dir: string;
  let settings: NotionSettings;
  let api: FakeNotionApi;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-notion-'));
    settings = new NotionSettings(path.join(dir, 'notion.json'));
    api = new FakeNotionApi();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates Meetings, then Action Items related to it, and saves where they are', async () => {
    const { setup, created } = await setupNotion(api, settings, 'parent-1', silentLogger);

    expect(created).toBe(true);
    expect(api.databases).toHaveLength(2);
    const [meetings, actionItems] = api.databases;
    expect(Object.keys(meetings?.initial_data_source?.properties ?? {})).toEqual([
      'Title', 'Date', 'Duration (min)', 'Channel', 'Participants', 'Type', 'Status', 'Trigger', 'Recording', 'Transcript',
    ]);
    expect(actionItems?.initial_data_source?.properties?.Meeting).toEqual({
      relation: { data_source_id: setup.meetings.dataSourceId, type: 'dual_property', dual_property: { synced_property_name: 'Action items' } },
    });
    expect(setup.meetings.statusType).toBe('status');
    expect(JSON.parse(await readFile(settings.file, 'utf8'))).toEqual(setup);
  });

  it('changes nothing when the saved databases still exist', async () => {
    const first = await setupNotion(api, settings, 'parent-1', silentLogger);
    const again = await setupNotion(api, settings, 'parent-2', silentLogger);
    expect(again).toEqual({ setup: first.setup, created: false });
    expect(api.databases).toHaveLength(2);
  });

  it('creates new databases when the saved ones are gone', async () => {
    const first = await setupNotion(api, settings, 'parent-1', silentLogger);
    api.missingDataSources.add(first.setup.meetings.dataSourceId);
    const again = await setupNotion(api, settings, 'parent-1', silentLogger);
    expect(again.created).toBe(true);
    expect(api.databases).toHaveLength(4);
  });

  it('falls back to a Select when Notion refuses a Status property', async () => {
    api.failOn('createDatabase', notionError(APIErrorCode.ValidationError, 'Cannot create status property'));
    const { setup } = await setupNotion(api, settings, 'parent-1', silentLogger);
    expect(setup.meetings.statusType).toBe('select');
    expect(api.databases[0]?.initial_data_source?.properties?.Status).toHaveProperty('select');
    expect(api.databases[1]?.initial_data_source?.properties?.Status).toHaveProperty('select');
  });

  it('explains a page that is not shared with the integration', () => {
    expect(describeSetupError(notionError(APIErrorCode.ObjectNotFound, 'Could not find page', 404))).toMatch(/Connections/);
    expect(describeSetupError(new Error('other'))).toBeUndefined();
  });
});
