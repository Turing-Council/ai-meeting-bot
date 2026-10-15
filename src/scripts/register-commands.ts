import { REST, Routes } from 'discord.js';
import { commands, inviteUrl } from '../bot/commands.js';
import { loadConfig } from '../config.js';

/**
 * Registers the slash commands. With DISCORD_GUILD_ID set they appear instantly in that server;
 * otherwise they are registered globally (can take up to an hour to show up).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const rest = new REST().setToken(config.discordToken);

  // Printed first: guild registration fails with "Missing Access" until the bot is in the server.
  console.log(`Invite the bot with:\n${inviteUrl(config.discordClientId)}\n`);

  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);
  await rest.put(route, { body: commands });

  console.log(
    config.discordGuildId
      ? `Registered ${commands.length} command(s) in server ${config.discordGuildId}.`
      : `Registered ${commands.length} global command(s).`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (message.includes('Missing Access')) {
    console.error(
      'Invite the bot to the server with the link above (it needs the applications.commands scope), then run this again.',
    );
  }
  process.exit(1);
});
