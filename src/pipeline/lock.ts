import { readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';

/** Another process (the bot or the reprocess script) is working on this session. */
export class SessionLockedError extends Error {
  constructor(readonly owner: string) {
    super(`The session is being processed by ${owner}`);
    this.name = 'SessionLockedError';
  }
}

export interface SessionLock {
  release(): Promise<void>;
}

export interface LockOptions {
  /** A lock whose heartbeat is older than this was left by a dead process and is taken over. */
  staleMs?: number;
  heartbeatMs?: number;
}

/**
 * A lock file next to the manifest, so the bot and the reprocess script never process the same
 * session at once. The holder touches the file regularly; a lock that stops being touched
 * (process killed, container replaced) goes stale and can be taken over.
 */
export async function acquireLock(file: string, label: string, options: LockOptions = {}): Promise<SessionLock> {
  const { staleMs = 120_000, heartbeatMs = 30_000 } = options;
  const owner = `${label} (pid ${process.pid} on ${os.hostname()})`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, `${JSON.stringify({ owner, since: new Date().toISOString() })}\n`, { flag: 'wx' });
      const heartbeat = setInterval(() => {
        const now = new Date();
        utimes(file, now, now).catch(() => undefined);
      }, heartbeatMs);
      heartbeat.unref();
      return {
        release: async () => {
          clearInterval(heartbeat);
          await rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const info = await stat(file).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs < staleMs) throw new SessionLockedError(await readOwner(file));
      await rm(file, { force: true }); // stale (or just released): take it over
    }
  }
  throw new SessionLockedError(await readOwner(file));
}

async function readOwner(file: string): Promise<string> {
  try {
    const { owner } = JSON.parse(await readFile(file, 'utf8')) as { owner?: unknown };
    return typeof owner === 'string' ? owner : 'another process';
  } catch {
    return 'another process';
  }
}
