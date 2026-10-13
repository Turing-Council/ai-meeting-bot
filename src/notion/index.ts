import path from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { SdkNotionApi, type NotionApi } from './api.js';
import { NotionPublisher } from './publisher.js';
import { NotionSettings } from './settings.js';

export interface NotionContext {
  api: NotionApi;
  settings: NotionSettings;
  publisher: NotionPublisher;
}

/** Notion access, or undefined when no NOTION_TOKEN is configured. */
export function createNotion(config: Config, logger: Logger): NotionContext | undefined {
  if (!config.notionToken) return undefined;
  const api = new SdkNotionApi(config.notionToken);
  const settings = new NotionSettings(path.resolve(config.dataDir, 'notion.json'));
  return { api, settings, publisher: new NotionPublisher(api, settings, logger) };
}
