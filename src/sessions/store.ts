import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger.js';
import { SessionManifest } from './manifest.js';

const MANIFEST_FILE = 'manifest.json';

/**
 * Stores each session as a directory: `<root>/<sessionId>/manifest.json` plus its audio.
 * Manifests are written atomically (temp file + rename), so a crash never leaves a torn file.
 */
export class SessionStore {
  constructor(
    readonly root: string,
    private readonly logger: Logger,
  ) {}

  sessionDir(id: string): string {
    return path.join(this.root, id);
  }

  /** Absolute path of a file inside a session directory (manifest paths are relative). */
  resolve(id: string, relativeFile: string): string {
    return path.join(this.sessionDir(id), relativeFile);
  }

  async create(manifest: SessionManifest): Promise<void> {
    await mkdir(path.join(this.sessionDir(manifest.id), 'tracks'), { recursive: true });
    await this.save(manifest);
  }

  async save(manifest: SessionManifest): Promise<void> {
    const valid = SessionManifest.parse(manifest);
    await writeFileAtomic(path.join(this.sessionDir(valid.id), MANIFEST_FILE), `${JSON.stringify(valid, null, 2)}\n`);
  }

  async load(id: string): Promise<SessionManifest> {
    const raw = await readFile(path.join(this.sessionDir(id), MANIFEST_FILE), 'utf8');
    return SessionManifest.parse(JSON.parse(raw));
  }

  /** The guild's most recent readable session (IDs sort chronologically). */
  async latest(guildId: string): Promise<SessionManifest | undefined> {
    for (const id of (await this.ids()).reverse()) {
      const manifest = await this.load(id).catch(() => undefined);
      if (manifest?.guildId === guildId) return manifest;
    }
    return undefined;
  }

  /** All readable sessions, oldest first. Unreadable ones are logged and skipped. */
  async list(): Promise<SessionManifest[]> {
    const manifests: SessionManifest[] = [];
    for (const id of await this.ids()) {
      try {
        manifests.push(await this.load(id));
      } catch (error) {
        this.logger.warn('Skipping unreadable session', { sessionId: id, error });
      }
    }
    return manifests;
  }

  /** Session directory names, oldest first. */
  private async ids(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

let tmpCounter = 0;

/** Writes via a temp file + rename, so readers (and crashes) never see a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
