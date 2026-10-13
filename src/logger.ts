const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

/** Minimal structured logger: one JSON object per line, which Dokploy's log viewer handles well. */
export function createLogger(level: LogLevel = 'info', base: Record<string, unknown> = {}): Logger {
  const threshold = LEVELS[level];

  const log = (lvl: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg: message, ...base };
    for (const [key, value] of Object.entries(fields)) entry[key] = serializeError(value);
    const line = JSON.stringify(entry);
    if (LEVELS[lvl] >= LEVELS.warn) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}

/** A logger that discards everything; handy in tests. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
