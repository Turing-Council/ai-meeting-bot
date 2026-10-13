import { InteractionContextType, PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from 'discord.js';

export const meetingCommand = new SlashCommandBuilder()
  .setName('meeting')
  .setDescription('Record meetings in voice channels')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription('Join your voice channel and start recording')
      .addStringOption((opt) => opt.setName('title').setDescription('Meeting title').setMaxLength(200))
      .addStringOption((opt) =>
        opt.setName('type').setDescription('Kind of meeting, e.g. Standup or Planning').setMaxLength(100),
      ),
  )
  .addSubcommand((sub) => sub.setName('stop').setDescription('Stop recording and leave the voice channel'))
  .addSubcommand((sub) =>
    sub
      .setName('note')
      .setDescription('Add a timestamped bookmark to the current recording')
      .addStringOption((opt) =>
        opt.setName('text').setDescription('What happened at this moment').setRequired(true).setMaxLength(500),
      ),
  )
  .addSubcommand((sub) => sub.setName('status').setDescription('Show the current recording'));

export const commands = [meetingCommand.toJSON()];

/** Permissions the bot needs in the server; used to build the invite link. */
export const BOT_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles, // transcript.md on the panel
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.ChangeNickname,
]);

export function inviteUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: 'bot applications.commands',
    permissions: BOT_PERMISSIONS.bitfield.toString(),
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
