import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url({ error: 'must be a URL' }).optional());
const withDefault = <T extends z.ZodType>(schema: T, value: z.input<T>) => z.preprocess(emptyToUndefined, schema.default(value as never));

const requiredString = z.string({ error: 'is required' }).min(1, 'is required');
const booleanFlag = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.enum(['true', 'false', '1', '0', 'yes', 'no', '']).optional().transform((v) => v === 'true' || v === '1' || v === 'yes'),
);

const BaseSchema = z.object({
  DATA_DIR: withDefault(z.string(), './data'),
  EMPTY_CHANNEL_TIMEOUT_MIN: withDefault(z.coerce.number().min(0), 2),
  RECORDER_ROLE_ID: optionalString,
  FFMPEG_PATH: withDefault(z.string(), 'ffmpeg'),
  LOG_LEVEL: withDefault(z.enum(['debug', 'info', 'warn', 'error']), 'info'),

  STT_PROVIDER: withDefault(z.enum(['none', 'mock', 'openai-compatible']), 'none'),
  STT_BASE_URL: optionalUrl,
  STT_API_KEY: optionalString,
  STT_MODEL: optionalString,
  STT_LANGUAGE: withDefault(z.string(), 'en'),
  STT_RESPONSE_FORMAT: withDefault(z.enum(['verbose_json', 'json']), 'verbose_json'),

  LLM_PROVIDER: withDefault(z.enum(['none', 'mock', 'openai-compatible']), 'none'),
  LLM_BASE_URL: optionalUrl,
  LLM_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  LLM_JSON_MODE: withDefault(z.enum(['json_object', 'none']), 'json_object'),
  LLM_TEMPERATURE: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(2).optional()),
  LLM_CHUNK_CHARS: withDefault(z.coerce.number().int().min(2000), 48_000),

  NOTION_TOKEN: optionalString,
  COLLECT_CHAT_MATERIALS: booleanFlag,

  LIVE_TRANSCRIPTION: booleanFlag,
  LIVE_STT_MODEL: optionalString,
  LIVE_SILENCE_MS: withDefault(z.coerce.number().int().min(200), 800),
  LIVE_MAX_UTTERANCE_S: withDefault(z.coerce.number().min(3), 20),
  LIVE_CONCURRENCY: withDefault(z.coerce.number().int().min(1), 2),
});

const DiscordSchema = z.object({
  DISCORD_TOKEN: requiredString,
  DISCORD_CLIENT_ID: requiredString,
  DISCORD_GUILD_ID: optionalString,
});

export type SttConfig =
  | { provider: 'none' }
  | { provider: 'mock'; language: string }
  | {
      provider: 'openai-compatible';
      baseUrl: string;
      apiKey: string | undefined;
      model: string;
      language: string;
      responseFormat: 'verbose_json' | 'json';
      timeoutMs?: number;
      attempts?: number;
    };

/** Live transcription: speech is sent to the STT server utterance by utterance while the meeting runs. */
export interface LiveConfig {
  stt: SttConfig;
  /** A speaker's pause this long ends an utterance. */
  silenceMs: number;
  maxUtteranceMs: number;
  /** Parallel requests to the STT server. */
  concurrency: number;
}

export type LlmConfig =
  | { provider: 'none' }
  | { provider: 'mock'; chunkChars: number }
  | {
      provider: 'openai-compatible';
      baseUrl: string;
      apiKey: string | undefined;
      model: string;
      jsonMode: 'json_object' | 'none';
      /** Unset = the provider's default (some models only accept their default). */
      temperature: number | undefined;
      chunkChars: number;
    };

export interface Config {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string | undefined;
  dataDir: string;
  emptyChannelTimeoutMs: number;
  recorderRoleId: string | undefined;
  ffmpegPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  stt: SttConfig;
  llm: LlmConfig;
  /** Notion integration secret; Notion features are off without it. */
  notionToken: string | undefined;
  /** Save files and links posted in the voice channel's chat (needs the Message Content intent). */
  collectChatMaterials: boolean;
  /** Undefined when live transcription is off. */
  live: LiveConfig | undefined;
}

export interface LoadConfigOptions {
  /** Offline scripts (e.g. reprocessing a session) don't talk to Discord. */
  requireDiscord?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): Config {
  const { requireDiscord = true } = options;
  const schema = (requireDiscord ? DiscordSchema : DiscordSchema.partial()).extend(BaseSchema.shape);
  const parsed = schema.safeParse(env);
  const issues = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  if (parsed.success) {
    const c = parsed.data;
    for (const prefix of ['STT', 'LLM'] as const) {
      if (c[`${prefix}_PROVIDER`] !== 'openai-compatible') continue;
      if (!c[`${prefix}_BASE_URL`]) issues.push(`${prefix}_BASE_URL: is required when ${prefix}_PROVIDER=openai-compatible`);
      if (!c[`${prefix}_MODEL`]) issues.push(`${prefix}_MODEL: is required when ${prefix}_PROVIDER=openai-compatible`);
    }
  }
  if (parsed.success && parsed.data.LIVE_TRANSCRIPTION && parsed.data.STT_PROVIDER === 'none') {
    issues.push('LIVE_TRANSCRIPTION: needs STT_PROVIDER to be set (not none)');
  }
  if (!parsed.success || issues.length > 0) {
    throw new Error(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
  }

  const c = parsed.data;
  const stt: SttConfig =
    c.STT_PROVIDER === 'openai-compatible'
      ? {
          provider: 'openai-compatible',
          baseUrl: c.STT_BASE_URL ?? '',
          apiKey: c.STT_API_KEY,
          model: c.STT_MODEL ?? '',
          language: c.STT_LANGUAGE,
          responseFormat: c.STT_RESPONSE_FORMAT,
        }
      : c.STT_PROVIDER === 'mock'
        ? { provider: 'mock', language: c.STT_LANGUAGE }
        : { provider: 'none' };

  return {
    discordToken: c.DISCORD_TOKEN ?? '',
    discordClientId: c.DISCORD_CLIENT_ID ?? '',
    discordGuildId: c.DISCORD_GUILD_ID,
    dataDir: c.DATA_DIR,
    emptyChannelTimeoutMs: c.EMPTY_CHANNEL_TIMEOUT_MIN * 60_000,
    recorderRoleId: c.RECORDER_ROLE_ID,
    ffmpegPath: c.FFMPEG_PATH,
    logLevel: c.LOG_LEVEL,
    stt,
    llm:
      c.LLM_PROVIDER === 'openai-compatible'
        ? {
            provider: 'openai-compatible',
            baseUrl: c.LLM_BASE_URL ?? '',
            apiKey: c.LLM_API_KEY,
            model: c.LLM_MODEL ?? '',
            jsonMode: c.LLM_JSON_MODE,
            temperature: c.LLM_TEMPERATURE,
            chunkChars: c.LLM_CHUNK_CHARS,
          }
        : c.LLM_PROVIDER === 'mock'
          ? { provider: 'mock', chunkChars: c.LLM_CHUNK_CHARS }
          : { provider: 'none' },
    notionToken: c.NOTION_TOKEN,
    collectChatMaterials: c.COLLECT_CHAT_MATERIALS,
    live: c.LIVE_TRANSCRIPTION
      ? {
          stt: liveStt(stt, c.LIVE_STT_MODEL),
          silenceMs: c.LIVE_SILENCE_MS,
          maxUtteranceMs: c.LIVE_MAX_UTTERANCE_S * 1000,
          concurrency: c.LIVE_CONCURRENCY,
        }
      : undefined,
  };
}

/** A stalled server must not block the live queue for minutes, so live requests fail fast. */
function liveStt(stt: SttConfig, model: string | undefined): SttConfig {
  return stt.provider === 'openai-compatible' ? { ...stt, model: model ?? stt.model, timeoutMs: 15_000, attempts: 2 } : stt;
}
