import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const ConfigSchema = z.object({
  DISCORD_TOKEN: z.string({ error: 'is required' }).min(1, 'is required'),
  DISCORD_CLIENT_ID: z.string({ error: 'is required' }).min(1, 'is required'),
  DISCORD_GUILD_ID: optionalString,
  DATA_DIR: z.preprocess(emptyToUndefined, z.string().default('./data')),
  EMPTY_CHANNEL_TIMEOUT_MIN: z.preprocess(emptyToUndefined, z.coerce.number().min(0).default(2)),
  RECORDER_ROLE_ID: optionalString,
  FFMPEG_PATH: z.preprocess(emptyToUndefined, z.string().default('ffmpeg')),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(['debug', 'info', 'warn', 'error']).default('info')),
});

export interface Config {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string | undefined;
  dataDir: string;
  emptyChannelTimeoutMs: number;
  recorderRoleId: string | undefined;
  ffmpegPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${issues.join('\n')}`);
  }
  const c = parsed.data;
  return {
    discordToken: c.DISCORD_TOKEN,
    discordClientId: c.DISCORD_CLIENT_ID,
    discordGuildId: c.DISCORD_GUILD_ID,
    dataDir: c.DATA_DIR,
    emptyChannelTimeoutMs: c.EMPTY_CHANNEL_TIMEOUT_MIN * 60_000,
    recorderRoleId: c.RECORDER_ROLE_ID,
    ffmpegPath: c.FFMPEG_PATH,
    logLevel: c.LOG_LEVEL,
  };
}
