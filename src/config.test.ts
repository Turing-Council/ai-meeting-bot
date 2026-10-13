import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults and treats empty strings as unset', () => {
    const config = loadConfig({
      DISCORD_TOKEN: 't',
      DISCORD_CLIENT_ID: 'c',
      DISCORD_GUILD_ID: '',
      RECORDER_ROLE_ID: '',
      EMPTY_CHANNEL_TIMEOUT_MIN: '',
    });
    expect(config).toEqual({
      discordToken: 't',
      discordClientId: 'c',
      discordGuildId: undefined,
      dataDir: './data',
      emptyChannelTimeoutMs: 120_000,
      recorderRoleId: undefined,
      ffmpegPath: 'ffmpeg',
      logLevel: 'info',
    });
  });

  it('parses numbers and optional values', () => {
    const config = loadConfig({
      DISCORD_TOKEN: 't',
      DISCORD_CLIENT_ID: 'c',
      EMPTY_CHANNEL_TIMEOUT_MIN: '0.5',
      RECORDER_ROLE_ID: 'r',
      LOG_LEVEL: 'debug',
    });
    expect(config.emptyChannelTimeoutMs).toBe(30_000);
    expect(config.recorderRoleId).toBe('r');
    expect(config.logLevel).toBe('debug');
  });

  it('lists every missing or invalid variable', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/DISCORD_TOKEN[\s\S]*DISCORD_CLIENT_ID[\s\S]*LOG_LEVEL/);
  });
});
