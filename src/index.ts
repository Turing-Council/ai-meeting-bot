import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { generateDependencyReport } from '@discordjs/voice';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { handleInteraction } from './bot/interactions.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { runFfmpeg } from './recorder/mixdown.js';
import { SessionManager } from './sessions/manager.js';
import { SessionStore } from './sessions/store.js';

const SHUTDOWN_TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const sessionsDir = path.resolve(config.dataDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  logger.debug('Voice dependencies', { report: generateDependencyReport() });
  await runFfmpeg(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-version']).catch((error: unknown) =>
    logger.warn('ffmpeg is not available: recordings will be saved per speaker but not mixed', { error }),
  );

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  const store = new SessionStore(sessionsDir, logger);
  const manager = new SessionManager({ client, store, config, logger });

  client.once(Events.ClientReady, (ready) => {
    logger.info('Logged in', { user: ready.user.tag, guilds: ready.guilds.cache.size, dataDir: sessionsDir });
    void manager.resetStaleNicknames();
    void manager.recoverInterrupted().catch((error: unknown) => logger.error('Recovery failed', { error }));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction, { manager, config, logger });
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => manager.handleVoiceStateUpdate(oldState, newState));
  client.on(Events.Error, (error) => logger.error('Discord client error', { error }));
  client.on(Events.Warn, (message) => logger.warn('Discord client warning', { message }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    // Close audio files cleanly; unfinished sessions are mixed on next start.
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref());
    await Promise.race([manager.shutdown().catch((error: unknown) => logger.error('Shutdown error', { error })), timeout]);
    await client.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (error) => logger.error('Unhandled rejection', { error }));

  await client.login(config.discordToken);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
