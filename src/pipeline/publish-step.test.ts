import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger.js';
import { NotionPublisher } from '../notion/publisher.js';
import { NotionSettings } from '../notion/settings.js';
import { setupNotion } from '../notion/setup.js';
import type { SessionManifest } from '../sessions/manifest.js';
import { SessionStore } from '../sessions/store.js';
import { FakeNotionApi } from '../test-utils/fake-notion.js';
import { publishStep } from './publish-step.js';
import type { PipelineStep, StepContext } from './runner.js';

const TURNS = 250; // more than one append batch

describe('publish step', () => {
  let dir: string;
  let store: SessionStore;
  let api: FakeNotionApi;
  let publisher: NotionPublisher;
  let step: PipelineStep;
  let actionItemsDataSource: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-publish-'));
    store = new SessionStore(path.join(dir, 'sessions'), silentLogger);
    api = new FakeNotionApi();
    const settings = new NotionSettings(path.join(dir, 'notion.json'));
    actionItemsDataSource = (await setupNotion(api, settings, 'parent', silentLogger)).setup.actionItems.dataSourceId;
    publisher = new NotionPublisher(api, settings, silentLogger);
    step = publishStep({ publisher });

    const manifest: SessionManifest = {
      version: 1,
      id: 's1',
      title: 'Weekly sync',
      trigger: 'manual',
      status: 'recorded',
      guildId: 'g',
      voiceChannelId: 'v',
      voiceChannelName: 'General',
      startedBy: { id: 'u1', name: 'Alice' },
      startedAt: '2026-10-13T14:00:00.000Z',
      endedAt: '2026-10-13T14:30:00.000Z',
      durationMs: 1_800_000,
      participants: [{ id: 'u1', name: 'Alice' }],
      tracks: [{ userId: 'u1', file: 'tracks/u1.ogg' }],
      pauses: [],
      bookmarks: [],
      mixedFile: 'mixed.ogg',
      transcriptFile: 'transcript.md',
      transcriptDataFile: 'transcript.json',
      summaryFile: 'summary.json',
    };
    await store.create(manifest);
    await writeFile(store.resolve('s1', 'mixed.ogg'), 'audio');
    await writeFile(store.resolve('s1', 'transcript.md'), '# Weekly sync');
    const turns = Array.from({ length: TURNS }, (_, i) => ({ speakerId: 'u1', speaker: 'Alice', startMs: i * 1000, endMs: i * 1000 + 900, text: `line ${i}` }));
    await writeFile(store.resolve('s1', 'transcript.json'), JSON.stringify({ version: 1, sessionId: 's1', turns }));
    await writeFile(
      store.resolve('s1', 'summary.json'),
      JSON.stringify({
        tldr: 'Ship it.',
        keyPoints: [],
        decisions: ['Ship Friday'],
        actionItems: [
          { task: 'Write notes', owner: 'Alice', due: null },
          { task: 'Book room', owner: null, due: '2026-10-20' },
        ],
        openQuestions: [],
      }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs the step the way the runner does, with checkpoints saved to disk; a crash keeps only what was checkpointed. */
  async function run(): Promise<SessionManifest> {
    const manifest = await store.load('s1');
    const context: StepContext = {
      manifest,
      logger: silentLogger,
      resolve: (f) => store.resolve('s1', f),
      checkpoint: () => store.save(manifest),
    };
    await step.run(context);
    await store.save(manifest);
    return manifest;
  }

  const actionItemPages = () => [...api.pages.values()].filter((p) => JSON.stringify(p.params.parent).includes(actionItemsDataSource));

  it('creates the page if needed, fills it in and marks it Done', async () => {
    const manifest = await run();
    const pageId = manifest.notion!.pageId;
    const page = api.pages.get(pageId)!;

    expect(page.properties.Status).toEqual({ status: { name: 'Done' } });
    expect(page.properties['Duration (min)']).toEqual({ number: 30 });
    expect(api.uploads.map((u) => [u.filename, u.contentType])).toEqual([
      ['recording.ogg', 'audio/ogg'],
      ['transcript.md', 'text/markdown'],
    ]);
    const outline = api.outline(pageId);
    expect(outline.filter((l) => l.startsWith('heading_2'))).toEqual([
      'heading_2: Summary',
      'heading_2: Decisions',
      'heading_2: Action items',
      'heading_2: Recording',
      'heading_2: Full transcript',
    ]);
    expect(outline.filter((l) => l.startsWith('  paragraph: [')).length).toBe(TURNS); // inside the toggle
    expect(actionItemPages().map((p) => p.properties.Meeting)).toEqual([
      { relation: [{ id: pageId }] },
      { relation: [{ id: pageId }] },
    ]);
  });

  it('retries without duplicating content, keeping what people added', async () => {
    api.failOn('createPage', new Error('Notion is down'), 3); // page, 1st action item, then fails on the 2nd
    await expect(run()).rejects.toThrow('Notion is down');
    const { notion } = await store.load('s1');
    expect(notion?.actionItemIds).toHaveLength(1);

    const humanNote = 'block-human';
    api.blocks.set(humanNote, { type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'my note' } }] } });
    api.children.get(notion!.pageId)!.push(humanNote);

    await run();
    const outline = api.outline(notion!.pageId);
    expect(outline.filter((l) => l === 'heading_2: Summary')).toHaveLength(1);
    expect(outline).toContain('paragraph: my note');
    expect(actionItemPages().map((p) => (p.properties.Task as { title: { text: { content: string } }[] }).title[0]?.text.content)).toEqual([
      'Write notes',
      'Book room',
    ]);
    expect(api.pages.get(notion!.pageId)?.properties.Status).toEqual({ status: { name: 'Done' } });
  });

  it('starting over reuses the page and recreates the action items', async () => {
    const first = await run();
    const context: StepContext = { manifest: first, logger: silentLogger, resolve: (f) => store.resolve('s1', f), checkpoint: () => store.save(first) };
    await step.reset?.(context);
    const second = await run();

    expect(second.notion?.pageId).toBe(first.notion?.pageId);
    expect(actionItemPages().filter((p) => p.trashed)).toHaveLength(2);
    expect(actionItemPages().filter((p) => !p.trashed)).toHaveLength(2);
  });

  it('fails clearly when Notion is not set up', async () => {
    await rm(path.join(dir, 'notion.json'));
    const unset = publishStep({ publisher: new NotionPublisher(api, new NotionSettings(path.join(dir, 'notion.json')), silentLogger) });
    const manifest = await store.load('s1');
    await expect(
      unset.run({ manifest, logger: silentLogger, resolve: (f) => store.resolve('s1', f), checkpoint: async () => {} }),
    ).rejects.toThrow(/run \/meeting setup/);
  });
});
