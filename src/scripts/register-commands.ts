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

  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);
  await rest.put(route, { body: commands });

  console.log(
    config.discordGuildId
      ? `Registered ${commands.length} command(s) in server ${config.discordGuildId}.`
      : `Registered ${commands.length} global command(s).`,
  );
  console.log(`Invite the bot with:\n${inviteUrl(config.discordClientId)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
