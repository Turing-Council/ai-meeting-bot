import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url({ error: 'must be a URL' }).optional());
const withDefault = <T extends z.ZodType>(schema: T, value: z.input<T>) => z.preprocess(emptyToUndefined, schema.default(value as never));

const requiredString = z.string({ error: 'is required' }).min(1, 'is required');

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
    };

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
  if (!parsed.success || issues.length > 0) {
    throw new Error(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
  }

  const c = parsed.data;
  return {
    discordToken: c.DISCORD_TOKEN ?? '',
    discordClientId: c.DISCORD_CLIENT_ID ?? '',
    discordGuildId: c.DISCORD_GUILD_ID,
    dataDir: c.DATA_DIR,
    emptyChannelTimeoutMs: c.EMPTY_CHANNEL_TIMEOUT_MIN * 60_000,
    recorderRoleId: c.RECORDER_ROLE_ID,
    ffmpegPath: c.FFMPEG_PATH,
    logLevel: c.LOG_LEVEL,
    stt:
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
          : { provider: 'none' },
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
  };
}
