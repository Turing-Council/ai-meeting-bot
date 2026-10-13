import { ButtonStyle, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { SessionManifest } from '../sessions/manifest.js';
import { inviteUrl } from './commands.js';
import { panelCustomId, parsePanelCustomId } from './custom-ids.js';
import { formatDuration, formatOffset, truncate } from './format.js';
import { buildPanel } from './panel.js';
import { canControlRecording } from './permissions.js';

const base: SessionManifest = {
  version: 1,
  id: '20261013-140000-abcd',
  title: 'Weekly sync',
  trigger: 'manual',
  status: 'recording',
  guildId: 'g',
  voiceChannelId: 'v',
  voiceChannelName: 'General',
  startedBy: { id: 'u1', name: 'Alice' },
  startedAt: '2026-10-13T14:00:00.000Z',
  participants: [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
  ],
  tracks: [],
  pauses: [],
  bookmarks: [],
};

const buttonIds = (session: SessionManifest) =>
  buildPanel(session).components.flatMap((row) => row.components.map((b) => (b.toJSON() as { custom_id: string }).custom_id));

describe('format', () => {
  it('formats durations and offsets', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(245_000)).toBe('4m 05s');
    expect(formatDuration(3_723_000)).toBe('1h 02m 03s');
    expect(formatOffset(65_000)).toBe('01:05');
    expect(formatOffset(3_723_400)).toBe('01:02:03');
  });

  it('truncates with an ellipsis', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 6)).toBe('hello…');
  });
});

describe('custom ids', () => {
  it('round-trips actions and session ids', () => {
    const id = panelCustomId('bookmark-modal', base.id);
    expect(parsePanelCustomId(id)).toEqual({ action: 'bookmark-modal', sessionId: base.id });
  });

  it('rejects foreign or malformed ids', () => {
    expect(parsePanelCustomId('other:pause:x')).toBeUndefined();
    expect(parsePanelCustomId('meeting:explode:x')).toBeUndefined();
    expect(parsePanelCustomId('meeting:pause')).toBeUndefined();
    expect(parsePanelCustomId('meeting:pause:x:y')).toBeUndefined();
  });
});

describe('buildPanel', () => {
  it('shows Pause, Bookmark and Stop while recording', () => {
    expect(buttonIds(base)).toEqual([
      `meeting:pause:${base.id}`,
      `meeting:bookmark:${base.id}`,
      `meeting:stop:${base.id}`,
    ]);
    const resume = buildPanel({ ...base, status: 'paused' }).components[0]!.components[0]!.toJSON() as { style: number };
    expect(resume.style).toBe(ButtonStyle.Success);
  });

  it('swaps Pause for Resume while paused', () => {
    expect(buttonIds({ ...base, status: 'paused' })[0]).toBe(`meeting:resume:${base.id}`);
  });

  it('removes the buttons once the meeting has ended', () => {
    expect(buildPanel({ ...base, status: 'finalizing' }).components).toEqual([]);
    expect(buildPanel({ ...base, status: 'recorded', durationMs: 60_000, endedAt: base.startedAt }).components).toEqual([]);
  });

  it('lists participants and the latest bookmarks', () => {
    const bookmarks = Array.from({ length: 7 }, (_, i) => ({ atMs: i * 60_000, text: `point ${i}`, by: base.startedBy }));
    const fields = buildPanel({ ...base, bookmarks }).embeds[0]!.toJSON().fields!;
    expect(fields.find((f) => f.name.startsWith('Participants'))!.value).toBe('Alice, Bob');
    const marks = fields.find((f) => f.name.startsWith('📝'))!;
    expect(marks.name).toBe('📝 Bookmarks (7)');
    expect(marks.value).toContain('…and 2 earlier');
    expect(marks.value).toContain('`06:00` point 6');
    expect(marks.value).not.toContain('point 1 ');
  });

  it('shows the duration and outcome after recording', () => {
    const embed = buildPanel({
      ...base,
      status: 'recorded',
      endedAt: '2026-10-13T15:00:00.000Z',
      durationMs: 3_600_000,
      tracks: [{ userId: 'u1', file: 'tracks/u1.ogg' }],
      interrupted: true,
    }).embeds[0]!.toJSON();
    expect(embed.fields!.find((f) => f.name === 'Duration')!.value).toBe('1h 00m 00s');
    expect(embed.description).toContain('1 speaker track(s) saved.');
    expect(embed.description).toContain('Recovered after an interruption.');
  });

  it('explains failures', () => {
    const embed = buildPanel({ ...base, status: 'failed', error: 'ffmpeg missing' }).embeds[0]!.toJSON();
    expect(embed.description).toContain('ffmpeg missing');
  });
});

describe('canControlRecording', () => {
  const member = (roles: string[], perms: bigint[] = []) => ({
    roles: { cache: new Set(roles) },
    permissions: new PermissionsBitField(perms),
  });

  it('allows everyone when no recorder role is configured', () => {
    expect(canControlRecording(member([]), undefined)).toBe(true);
  });

  it('requires the role or Manage Server when configured', () => {
    expect(canControlRecording(member(['r1']), 'r1')).toBe(true);
    expect(canControlRecording(member([], [PermissionFlagsBits.ManageGuild]), 'r1')).toBe(true);
    expect(canControlRecording(member(['other']), 'r1')).toBe(false);
  });
});

describe('inviteUrl', () => {
  it('requests the bot and commands scopes with the needed permissions', () => {
    const url = new URL(inviteUrl('123'));
    expect(url.searchParams.get('client_id')).toBe('123');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    const perms = new PermissionsBitField(BigInt(url.searchParams.get('permissions')!));
    expect(perms.has([PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages])).toBe(true);
  });
});
