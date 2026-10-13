import {
  ActionRowBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  type ModalSubmitInteraction,
  type RepliableInteraction,
} from 'discord.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { parseNotionId } from '../notion/ids.js';
import type { NotionContext } from '../notion/index.js';
import { describeSetupError, setupNotion } from '../notion/setup.js';
import { loadSummary } from '../pipeline/index.js';
import type { Pipeline } from '../pipeline/runner.js';
import type { Person } from '../sessions/manifest.js';
import { UserError, type SessionManager } from '../sessions/manager.js';
import type { SessionStore } from '../sessions/store.js';
import { BOOKMARK_TEXT_INPUT_ID, panelCustomId, parsePanelCustomId } from './custom-ids.js';
import { formatDuration, formatOffset } from './format.js';
import { buildPanel } from './panel.js';
import { canControlRecording } from './permissions.js';

export interface InteractionDeps {
  manager: SessionManager;
  store: SessionStore;
  pipeline: Pipeline;
  /** Undefined when NOTION_TOKEN isn't set. */
  notion?: NotionContext | undefined;
  config: Config;
  logger: Logger;
}

export async function handleInteraction(interaction: Interaction, deps: InteractionDeps): Promise<void> {
  if (!interaction.inCachedGuild()) {
    if (interaction.isRepliable()) await interaction.reply({ content: 'This only works in a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'meeting') {
      await handleMeetingCommand(interaction, deps);
    } else if (interaction.isButton()) {
      await handleButton(interaction, deps);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction, deps);
    }
  } catch (error) {
    if (!(error instanceof UserError)) deps.logger.error('Interaction failed', { error, id: interaction.id });
    if (interaction.isRepliable()) {
      const content = error instanceof UserError ? error.message : 'Something went wrong. Check the bot logs.';
      await replyEphemeral(interaction, content).catch(() => undefined);
    }
  }
}

async function handleMeetingCommand(
  interaction: ChatInputCommandInteraction<'cached'>,
  { manager, store, pipeline, notion, config, logger }: InteractionDeps,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const member = interaction.member;

  switch (sub) {
    case 'start': {
      requireControl(member, config);
      const voiceChannel = member.voice.channel;
      if (!voiceChannel) throw new UserError('Join a voice channel first, then run `/meeting start`.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await manager.start({
        guild: interaction.guild,
        voiceChannel,
        startedBy: person(member),
        trigger: 'manual',
        title: interaction.options.getString('title') ?? undefined,
        type: interaction.options.getString('type') ?? undefined,
        fallbackPanelChannel: interaction.channel?.isSendable() ? interaction.channel : undefined,
      });
      const panel = session.panelChannelId ? ` Controls are in <#${session.panelChannelId}>.` : '';
      await interaction.editReply(`🔴 Recording **${session.title}** in <#${voiceChannel.id}>.${panel}`);
      return;
    }

    case 'stop': {
      requireControl(member, config);
      if (!manager.getActive(interaction.guildId)) throw new UserError("I'm not recording anything in this server.");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const session = await manager.stop(interaction.guildId, `stopped by ${member.displayName}`);
      await interaction.editReply(stopSummary(session, pipeline));
      return;
    }

    case 'note': {
      const session = manager.getActive(interaction.guildId);
      if (!session) throw new UserError("I'm not recording anything in this server.");
      const text = interaction.options.getString('text', true);
      const { atMs } = await manager.addBookmark(session.id, text, person(member));
      await replyEphemeral(interaction, `📝 Bookmarked at \`${formatOffset(atMs)}\`.`);
      return;
    }

    case 'status': {
      const session = manager.getActive(interaction.guildId);
      if (session) {
        await interaction.reply({ ...buildPanel(session), components: [], flags: MessageFlags.Ephemeral });
        return;
      }
      // Not recording: show the last meeting instead, with its processing state and summary.
      const last = await store.latest(interaction.guildId);
      const content = 'Not recording right now. Use `/meeting start` from a voice channel.';
      if (!last) {
        await replyEphemeral(interaction, content);
        return;
      }
      const panel = buildPanel(last, { summary: await loadSummary(store, last) });
      await interaction.reply({ content: `${content} Last meeting:`, ...panel, components: [], flags: MessageFlags.Ephemeral });
      return;
    }

    case 'setup': {
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        throw new UserError('You need the Manage Server permission to set up Notion.');
      }
      if (!notion) throw new UserError('Notion is not configured: set NOTION_TOKEN and redeploy first.');
      const parentId = parseNotionId(interaction.options.getString('parent', true));
      if (!parentId) throw new UserError("That doesn't look like a Notion page link. Copy it with ••• → Copy link.");
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { setup, created } = await setupNotion(notion.api, notion.settings, parentId, logger);
        const links = `**Meetings:** ${setup.meetings.url}\n**Action Items:** ${setup.actionItems.url}`;
        await interaction.editReply(
          created
            ? `✅ Notion is set up. New meetings will be logged there.\n${links}`
            : `Notion is already set up, so nothing was changed.\n${links}`,
        );
      } catch (error) {
        const message = describeSetupError(error);
        if (!message) throw error;
        throw new UserError(message);
      }
      return;
    }

    default:
      throw new UserError(`Unknown subcommand: ${sub}`);
  }
}

async function handleButton(interaction: ButtonInteraction<'cached'>, { manager, pipeline, config }: InteractionDeps): Promise<void> {
  const parsed = parsePanelCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.action === 'retry') {
    requireControl(interaction.member, config);
    await interaction.update(buildPanel(await pipeline.retry(parsed.sessionId)));
    return;
  }

  const session = manager.getActiveBySessionId(parsed.sessionId);
  if (!session) throw new UserError('This meeting is no longer being recorded.');

  switch (parsed.action) {
    case 'pause': {
      requireControl(interaction.member, config);
      await interaction.update(buildPanel(await manager.pause(session.id)));
      return;
    }
    case 'resume': {
      requireControl(interaction.member, config);
      await interaction.update(buildPanel(await manager.resume(session.id)));
      return;
    }
    case 'stop': {
      requireControl(interaction.member, config);
      // Acknowledge now; stopping (mixdown) can take longer than Discord's 3 s limit.
      await interaction.deferUpdate();
      const stopped = await manager.stop(interaction.guildId, `stopped by ${interaction.member.displayName}`);
      await interaction.followUp({ content: stopSummary(stopped, pipeline), flags: MessageFlags.Ephemeral });
      return;
    }
    case 'bookmark': {
      const elapsed = manager.elapsedMs(session.id) ?? 0;
      const input = new TextInputBuilder()
        .setCustomId(BOOKMARK_TEXT_INPUT_ID)
        .setLabel(`Bookmark at ${formatOffset(elapsed)}`)
        .setPlaceholder('e.g. Decision: ship v1 on Friday')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true);
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(panelCustomId('bookmark-modal', session.id))
          .setTitle('Add a bookmark')
          .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
      );
      return;
    }
    default:
      return;
  }
}

async function handleModal(interaction: ModalSubmitInteraction<'cached'>, { manager }: InteractionDeps): Promise<void> {
  const parsed = parsePanelCustomId(interaction.customId);
  if (parsed?.action !== 'bookmark-modal') return;
  const text = interaction.fields.getTextInputValue(BOOKMARK_TEXT_INPUT_ID);
  const { atMs } = await manager.addBookmark(parsed.sessionId, text, person(interaction.member));
  await replyEphemeral(interaction, `📝 Bookmarked at \`${formatOffset(atMs)}\`.`);
}

function requireControl(member: GuildMember, config: Config): void {
  if (!canControlRecording(member, config.recorderRoleId)) {
    throw new UserError(`You need the <@&${config.recorderRoleId}> role to control recordings.`);
  }
}

function person(member: GuildMember): Person {
  return { id: member.id, name: member.displayName };
}

function stopSummary(session: { durationMs?: number | undefined; tracks: unknown[] }, pipeline: Pipeline): string {
  const duration = session.durationMs !== undefined ? formatDuration(session.durationMs) : 'unknown length';
  if (session.tracks.length === 0) return `⏹️ Recording stopped (${duration}). Nobody spoke, so there is no audio.`;
  const steps = pipeline.stepNames;
  const results = steps.includes('summarize')
    ? 'the mixed audio, transcript and summary'
    : steps.includes('transcribe')
      ? 'the mixed audio and transcript'
      : 'the mixed audio';
  const where = steps.includes('publish') ? 'on the panel and in Notion' : 'on the panel';
  return `⏹️ Recording saved: ${duration}, ${session.tracks.length} speaker track(s). Progress and ${results} will appear ${where}.`;
}

async function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}
