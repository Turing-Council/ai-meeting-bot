import path from 'node:path';
import type { Config } from '../config.js';
import { SdkNotionApi, type NotionApi } from './api.js';
import { NotionSettings } from './settings.js';

export interface NotionContext {
  api: NotionApi;
  settings: NotionSettings;
}

/** Notion access, or undefined when no NOTION_TOKEN is configured. */
export function createNotion(config: Config): NotionContext | undefined {
  if (!config.notionToken) return undefined;
  return {
    api: new SdkNotionApi(config.notionToken),
    settings: new NotionSettings(path.resolve(config.dataDir, 'notion.json')),
  };
}
