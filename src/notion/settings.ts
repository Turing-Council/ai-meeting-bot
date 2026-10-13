import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from '../sessions/store.js';

const DatabaseRef = z.object({
  databaseId: z.string(),
  dataSourceId: z.string(),
  url: z.string(),
  statusType: z.enum(['status', 'select']),
});

/** `$DATA_DIR/notion.json`: where the bot's databases are, written by setup. */
export const NotionSetup = z.object({
  version: z.literal(1),
  parentPageId: z.string(),
  meetings: DatabaseRef,
  actionItems: DatabaseRef,
  createdAt: z.string(),
});
export type NotionSetup = z.infer<typeof NotionSetup>;
export type DatabaseRef = z.infer<typeof DatabaseRef>;

/**
 * Reads and writes `notion.json`. Kept on the data volume rather than in env vars, so running
 * setup takes effect immediately, without a redeploy.
 */
export class NotionSettings {
  private cached: NotionSetup | undefined;

  constructor(readonly file: string) {}

  /** The saved setup, or undefined if setup hasn't been run yet. */
  async get(): Promise<NotionSetup | undefined> {
    if (this.cached) return this.cached;
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    this.cached = NotionSetup.parse(JSON.parse(raw));
    return this.cached;
  }

  async save(setup: NotionSetup): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(NotionSetup.parse(setup), null, 2)}\n`);
    this.cached = setup;
  }
}
