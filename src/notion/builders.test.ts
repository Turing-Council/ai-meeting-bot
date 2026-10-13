import { describe, expect, it } from 'vitest';
import type { SessionManifest } from '../sessions/manifest.js';
import { meetingBody, transcriptToggleIndex } from './blocks.js';
import { actionItemProperties, meetingProperties } from './properties.js';
import { batches, MAX_TEXT_CHARS, optionName, richText } from './rich-text.js';
import { blockType } from '../test-utils/fake-notion.js';

const manifest: SessionManifest = {
  version: 1,
  id: '20261013-140000-abcd',
  title: 'Weekly sync',
  type: 'Planning, Q4',
  trigger: 'manual',
  status: 'recorded',
  guildId: 'g',
  voiceChannelId: 'v',
  voiceChannelName: 'General',
  startedBy: { id: 'u1', name: 'Alice' },
  startedAt: '2026-10-13T14:00:00.000Z',
  endedAt: '2026-10-13T14:45:30.000Z',
  durationMs: 2_730_000,
  participants: [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob, the builder' },
  ],
  tracks: [],
  pauses: [],
  bookmarks: [{ atMs: 60_000, text: 'Decision time', by: { id: 'u1', name: 'Alice' } }],
};

const headings = (blocks: ReturnType<typeof meetingBody>['blocks']) =>
  blocks.filter((b) => blockType(b) === 'heading_2').map((b) => ('heading_2' in b ? b.heading_2.rich_text.map((t) => ('text' in t ? t.text.content : '')).join('') : ''));

describe('rich text', () => {
  it('splits text over 2000 characters into several items', () => {
    const items = richText('x'.repeat(MAX_TEXT_CHARS * 2 + 5), { text: 'tail', bold: true });
    expect(items.map((i) => i.text.content.length)).toEqual([2000, 2000, 5, 4]);
    expect(items[3]?.annotations).toEqual({ bold: true });
  });

  it('batches by 100 and cleans select option names', () => {
    expect(batches(Array.from({ length: 250 }, (_, i) => i)).map((b) => b.length)).toEqual([100, 100, 50]);
    expect(optionName('Bob, the builder')).toBe('Bob the builder');
  });
});

describe('meetingProperties', () => {
  it('maps the session, cleaning option names and rounding the duration', () => {
    const props = meetingProperties(manifest, 'Done', 'status', { recording: 'up-1', transcript: 'up-2' });
    expect(props).toMatchObject({
      Title: { title: [{ text: { content: 'Weekly sync' } }] },
      Date: { date: { start: '2026-10-13T14:00:00.000Z', end: '2026-10-13T14:45:30.000Z' } },
      'Duration (min)': { number: 45.5 },
      Channel: { select: { name: 'General' } },
      Participants: { multi_select: [{ name: 'Alice' }, { name: 'Bob the builder' }] },
      Type: { multi_select: [{ name: 'Planning Q4' }] },
      Status: { status: { name: 'Done' } },
      Trigger: { select: { name: 'Manual' } },
      Recording: { files: [{ type: 'file_upload', file_upload: { id: 'up-1' }, name: 'recording.ogg' }] },
      Transcript: { files: [{ type: 'file_upload', file_upload: { id: 'up-2' }, name: 'transcript.md' }] },
    });
  });

  it('leaves out what is not known yet at the start, and uses a select for status when needed', () => {
    const { endedAt: _e, durationMs: _d, ...live } = manifest;
    const props = meetingProperties({ ...live, status: 'recording' }, 'Recording', 'select');
    expect(props.Date).toEqual({ date: { start: '2026-10-13T14:00:00.000Z' } });
    expect(props.Status).toEqual({ select: { name: 'Recording' } });
    expect(props).not.toHaveProperty('Duration (min)');
    expect(props).not.toHaveProperty('Recording');
  });

  it('links action items to the meeting', () => {
    expect(actionItemProperties({ task: 'Write notes', owner: 'Bob', due: '2026-10-16' }, 'page-1', 'status')).toEqual({
      Task: { title: [{ type: 'text', text: { content: 'Write notes' } }] },
      Owner: { rich_text: [{ type: 'text', text: { content: 'Bob' } }] },
      Due: { date: { start: '2026-10-16' } },
      Status: { status: { name: 'To do' } },
      Meeting: { relation: [{ id: 'page-1' }] },
    });
  });
});

describe('meetingBody', () => {
  const summary = {
    tldr: 'Ship v1.',
    keyPoints: ['Release plan'],
    decisions: ['Ship on Friday'],
    actionItems: [{ task: 'Write notes', owner: 'Bob', due: null }],
    openQuestions: [],
  };
  const turns = [{ speakerId: 'u1', speaker: 'Alice', startMs: 5_000, endMs: 9_000, text: 'Hello.' }];

  it('follows the template order and leaves out empty sections', () => {
    const body = meetingBody({
      manifest: { ...manifest, materials: [{ kind: 'link', name: 'https://x.test', url: 'https://x.test', by: manifest.startedBy, atMs: 0, messageId: 'm1' }] },
      summary,
      turns,
      recordingUpload: 'up-1',
    });
    expect(headings(body.blocks)).toEqual(['Summary', 'Decisions', 'Action items', 'Bookmarks', 'Materials', 'Recording', 'Full transcript']);
    expect(body.blocks.map(blockType)).toContain('audio');
    expect(body.blocks.map(blockType)).toContain('bookmark');
    expect(transcriptToggleIndex(body)).toBeGreaterThan(0);
    expect(body.transcript).toHaveLength(1);
  });

  it('works without a summary or transcript (providers off)', () => {
    const body = meetingBody({ manifest: { ...manifest, bookmarks: [] } });
    expect(headings(body.blocks)).toEqual([]);
    expect(body.blocks).toHaveLength(1); // just the footer
    expect(transcriptToggleIndex(body)).toBe(-1);
  });

  it('shows uploaded files, images and files that could not be kept', () => {
    const by = manifest.startedBy;
    const body = meetingBody({
      manifest: {
        ...manifest,
        bookmarks: [],
        materials: [
          { kind: 'file', name: 'plan.pdf', file: 'materials/a.pdf', contentType: 'application/pdf', by, atMs: 0, messageId: 'm1' },
          { kind: 'file', name: 'shot.png', file: 'materials/b.png', contentType: 'image/png', by, atMs: 0, messageId: 'm2' },
          { kind: 'file', name: 'huge.zip', url: 'https://cdn.test/huge.zip', by, atMs: 0, messageId: 'm3' },
        ],
      },
      materialUploads: new Map([
        ['materials/a.pdf', 'up-a'],
        ['materials/b.png', 'up-b'],
      ]),
    });
    expect(body.blocks.map(blockType)).toEqual(['heading_2', 'file', 'image', 'bulleted_list_item', 'paragraph']);
  });
});
