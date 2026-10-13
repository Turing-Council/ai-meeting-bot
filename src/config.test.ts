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
      stt: { provider: 'none' },
      llm: { provider: 'none' },
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

  it('configures OpenAI-compatible providers', () => {
    const config = loadConfig({
      DISCORD_TOKEN: 't',
      DISCORD_CLIENT_ID: 'c',
      STT_PROVIDER: 'openai-compatible',
      STT_BASE_URL: 'http://whisper:8000/v1',
      STT_MODEL: 'large-v3',
      LLM_PROVIDER: 'openai-compatible',
      LLM_BASE_URL: 'https://llm.example.com/v1',
      LLM_API_KEY: 'k',
      LLM_MODEL: 'some-model',
      LLM_TEMPERATURE: '0.2',
    });
    expect(config.stt).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://whisper:8000/v1',
      apiKey: undefined,
      model: 'large-v3',
      language: 'en',
      responseFormat: 'verbose_json',
    });
    expect(config.llm).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://llm.example.com/v1',
      apiKey: 'k',
      model: 'some-model',
      jsonMode: 'json_object',
      temperature: 0.2,
      chunkChars: 48_000,
    });
  });

  it('requires a base URL and model for OpenAI-compatible providers', () => {
    expect(() => loadConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c', LLM_PROVIDER: 'openai-compatible' })).toThrow(
      /LLM_BASE_URL[\s\S]*LLM_MODEL/,
    );
    expect(() => loadConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c', STT_PROVIDER: 'openai-compatible', STT_BASE_URL: 'nope' })).toThrow(
      /STT_BASE_URL: must be a URL/,
    );
  });

  it('does not require Discord settings for offline scripts', () => {
    const config = loadConfig({ STT_PROVIDER: 'mock' }, { requireDiscord: false });
    expect(config.discordToken).toBe('');
    expect(config.stt).toEqual({ provider: 'mock', language: 'en' });
  });
});
