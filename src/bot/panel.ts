import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { SessionManifest, SessionStatus } from '../sessions/manifest.js';
import { panelCustomId } from './custom-ids.js';
import { discordRelativeTime, formatDuration, formatOffset, truncate } from './format.js';

const STATUS_LABEL: Record<SessionStatus, string> = {
  recording: '🔴 Recording',
  paused: '⏸️ Paused',
  finalizing: '⏳ Saving recording…',
  recorded: '✅ Recorded',
  failed: '⚠️ Failed',
};

const STATUS_COLOR: Record<SessionStatus, number> = {
  recording: 0xed4245,
  paused: 0xfee75c,
  finalizing: 0x5865f2,
  recorded: 0x57f287,
  failed: 0x99aab5,
};

const MAX_LISTED_BOOKMARKS = 5;

export interface PanelMessage {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** The control panel message for a session, in its current state. */
export function buildPanel(session: SessionManifest): PanelMessage {
  const embed = new EmbedBuilder()
    .setTitle(truncate(session.title, 256))
    .setColor(STATUS_COLOR[session.status])
    .addFields(
      { name: 'Status', value: STATUS_LABEL[session.status], inline: true },
      { name: 'Channel', value: `<#${session.voiceChannelId}>`, inline: true },
      {
        name: session.endedAt ? 'Duration' : 'Started',
        value:
          session.endedAt && session.durationMs !== undefined
            ? formatDuration(session.durationMs)
            : discordRelativeTime(session.startedAt),
        inline: true,
      },
      {
        name: `Participants (${session.participants.length})`,
        value: truncate(session.participants.map((p) => p.name).join(', ') || '—', 1024),
      },
    )
    .setFooter({ text: `Session ${session.id} · started by ${session.startedBy.name}` });

  if (session.type) embed.addFields({ name: 'Type', value: truncate(session.type, 1024), inline: true });

  if (session.bookmarks.length > 0) {
    const recent = session.bookmarks.slice(-MAX_LISTED_BOOKMARKS);
    const hidden = session.bookmarks.length - recent.length;
    const lines = recent.map((b) => `\`${formatOffset(b.atMs)}\` ${truncate(b.text, 150)} — ${b.by.name}`);
    if (hidden > 0) lines.unshift(`…and ${hidden} earlier`);
    embed.addFields({ name: `📝 Bookmarks (${session.bookmarks.length})`, value: truncate(lines.join('\n'), 1024) });
  }

  if (session.status === 'recorded') {
    const note = session.tracks.length === 0 ? 'Nobody spoke, so there is no audio.' : `${session.tracks.length} speaker track(s) saved.`;
    embed.setDescription(session.interrupted ? `${note}\nRecovered after an interruption.` : note);
  }
  if (session.status === 'failed' && session.error) {
    embed.setDescription(truncate(`Saving the recording failed: ${session.error}`, 4096));
  }

  return { embeds: [embed], components: buildButtons(session) };
}

function buildButtons(session: SessionManifest): ActionRowBuilder<ButtonBuilder>[] {
  if (session.status !== 'recording' && session.status !== 'paused') return [];

  const pauseButton =
    session.status === 'paused'
      ? new ButtonBuilder()
          .setCustomId(panelCustomId('resume', session.id))
          .setLabel('Resume')
          .setEmoji('▶️')
          .setStyle(ButtonStyle.Success)
      : new ButtonBuilder()
          .setCustomId(panelCustomId('pause', session.id))
          .setLabel('Pause')
          .setEmoji('⏸️')
          .setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      pauseButton,
      new ButtonBuilder()
        .setCustomId(panelCustomId('bookmark', session.id))
        .setLabel('Bookmark')
        .setEmoji('📝')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(panelCustomId('stop', session.id))
        .setLabel('Stop')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}
