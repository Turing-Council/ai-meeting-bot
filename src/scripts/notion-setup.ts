/**
 * Creates the Notion databases, like `/meeting setup` in Discord.
 *
 *   npm run notion:setup -- <link to the parent Notion page>
 */
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { parseNotionId } from '../notion/ids.js';
import { createNotion } from '../notion/index.js';
import { describeSetupError, setupNotion } from '../notion/setup.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env, { requireDiscord: false });
  const logger = createLogger(config.logLevel);
  const notion = createNotion(config, logger);
  if (!notion) throw new Error('Set NOTION_TOKEN first.');
  const parentId = parseNotionId(process.argv[2] ?? '');
  if (!parentId) throw new Error('Usage: npm run notion:setup -- <link to the parent Notion page>');

  try {
    const { setup, created } = await setupNotion(notion.api, notion.settings, parentId, logger);
    console.log(created ? 'Notion is set up.' : 'Notion was already set up; nothing changed.');
    console.log(`Meetings:     ${setup.meetings.url}\nAction Items: ${setup.actionItems.url}\nSaved to:     ${notion.settings.file}`);
  } catch (error) {
    throw new Error(describeSetupError(error) ?? (error instanceof Error ? error.message : String(error)));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
