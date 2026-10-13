import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { PIPELINE_STEPS, type SessionManifest, type SessionStatus, type StepName, type StepStatus } from '../sessions/manifest.js';
import type { ActionItem, Summary } from '../summarize/summary.js';
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
const MAX_LISTED_SUMMARY_ITEMS = 6;
/** Summary fields are kept short so the whole embed stays under Discord's 6000-character limit. */
const SUMMARY_FIELD_MAX = 600;

const STEP_LABEL: Record<StepName, string> = { mix: 'Audio', transcribe: 'Transcript', summarize: 'Summary' };
const STEP_ICON: Record<StepStatus, string> = { pending: '🕓', running: '⏳', done: '✅', failed: '⚠️' };

export interface PanelExtras {
  /** Shown once processing has produced it. */
  summary?: Summary | undefined;
}

export interface PanelMessage {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** The control panel message for a session, in its current state. */
export function buildPanel(session: SessionManifest, extras: PanelExtras = {}): PanelMessage {
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

  const steps = PIPELINE_STEPS.flatMap((name) => {
    const state = session.processing?.[name];
    return state ? [`${STEP_ICON[state.status]} ${STEP_LABEL[name]}`] : [];
  });
  if (steps.length > 0) {
    const failure = PIPELINE_STEPS.map((name) => session.processing?.[name]).find((s) => s?.status === 'failed');
    const value = failure?.error ? `${steps.join(' · ')}\n${truncate(failure.error, 300)}` : steps.join(' · ');
    embed.addFields({ name: 'Processing', value });
  }

  if (extras.summary) addSummary(embed, extras.summary);

  return { embeds: [embed], components: buildButtons(session) };
}

function addSummary(embed: EmbedBuilder, summary: Summary): void {
  if (summary.tldr) embed.setDescription(`**TL;DR** ${truncate(summary.tldr, 1000)}`);
  const sections: [string, string[]][] = [
    ['✅ Decisions', summary.decisions],
    ['📌 Action items', summary.actionItems.map(formatActionItem)],
    ['❓ Open questions', summary.openQuestions],
  ];
  for (const [name, items] of sections) {
    if (items.length === 0) continue;
    const shown = items.slice(0, MAX_LISTED_SUMMARY_ITEMS).map((item) => `• ${truncate(item, 200)}`);
    if (items.length > shown.length) shown.push(`…and ${items.length - shown.length} more`);
    embed.addFields({ name: `${name} (${items.length})`, value: truncate(shown.join('\n'), SUMMARY_FIELD_MAX) });
  }
}

function formatActionItem(item: ActionItem): string {
  const owner = item.owner ? ` — **${item.owner}**` : '';
  const due = item.due ? ` (due ${item.due})` : '';
  return `${item.task}${owner}${due}`;
}

function buildButtons(session: SessionManifest): ActionRowBuilder<ButtonBuilder>[] {
  const notionLink = session.notion?.pageUrl
    ? [new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(session.notion.pageUrl).setLabel('Open in Notion')]
    : [];
  const processingFailed = Object.values(session.processing ?? {}).some((state) => state.status === 'failed');
  if (processingFailed) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(panelCustomId('retry', session.id))
          .setLabel('Retry processing')
          .setEmoji('🔁')
          .setStyle(ButtonStyle.Secondary),
        ...notionLink,
      ),
    ];
  }
  if (session.status !== 'recording' && session.status !== 'paused') {
    return notionLink.length > 0 ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...notionLink)] : [];
  }

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
      ...notionLink,
    ),
  ];
}
