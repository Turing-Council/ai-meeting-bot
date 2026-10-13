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
    const file = path.join(this.sessionDir(valid.id), MANIFEST_FILE);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`);
    await rename(tmp, file);
  }

  async load(id: string): Promise<SessionManifest> {
    const raw = await readFile(path.join(this.sessionDir(id), MANIFEST_FILE), 'utf8');
    return SessionManifest.parse(JSON.parse(raw));
  }

  /** All readable sessions, oldest first. Unreadable ones are logged and skipped. */
  async list(): Promise<SessionManifest[]> {
    let entries: string[];
    try {
      entries = (await readdir(this.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const manifests: SessionManifest[] = [];
    for (const id of entries.sort()) {
      try {
        manifests.push(await this.load(id));
      } catch (error) {
        this.logger.warn('Skipping unreadable session', { sessionId: id, error });
      }
    }
    return manifests;
  }
}
