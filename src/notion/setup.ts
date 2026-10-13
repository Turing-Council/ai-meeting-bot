import { APIErrorCode, isNotionClientError } from '@notionhq/client';
import type { Logger } from '../logger.js';
import type { NotionApi } from './api.js';
import { actionItemsDatabase, meetingsDatabase, type StatusType } from './schema.js';
import type { NotionSettings, NotionSetup } from './settings.js';

export interface SetupResult {
  setup: NotionSetup;
  /** False when working databases already existed and nothing was created. */
  created: boolean;
}

/**
 * Creates the Meetings and Action Items databases under a page and saves where they are.
 * Safe to run again: while the saved databases are still reachable, it changes nothing.
 */
export async function setupNotion(api: NotionApi, settings: NotionSettings, parentPageId: string, logger: Logger): Promise<SetupResult> {
  const existing = await settings.get();
  if (existing) {
    const [meetings, actionItems] = await Promise.all([
      api.dataSourceExists(existing.meetings.dataSourceId),
      api.dataSourceExists(existing.actionItems.dataSourceId),
    ]);
    if (meetings && actionItems) return { setup: existing, created: false };
    logger.warn('Saved Notion databases are gone or no longer shared; creating new ones');
  }

  let statusType: StatusType = 'status';
  let meetings;
  try {
    meetings = await api.createDatabase(meetingsDatabase(parentPageId, statusType));
  } catch (error) {
    if (!isStatusRejected(error)) throw error;
    logger.warn('Notion refused a Status property; using a Select for status instead', { error });
    statusType = 'select';
    meetings = await api.createDatabase(meetingsDatabase(parentPageId, statusType));
  }
  const actionItems = await api.createDatabase(actionItemsDatabase(parentPageId, meetings.dataSourceId, statusType));

  const setup: NotionSetup = {
    version: 1,
    parentPageId,
    meetings: { ...meetings, statusType },
    actionItems: { ...actionItems, statusType },
    createdAt: new Date().toISOString(),
  };
  await settings.save(setup);
  logger.info('Notion databases created', { meetings: meetings.url, actionItems: actionItems.url });
  return { setup, created: true };
}

function isStatusRejected(error: unknown): boolean {
  return isNotionClientError(error) && error.code === APIErrorCode.ValidationError && /status/i.test(error.message);
}

/** A friendlier message for the errors people hit during setup. */
export function describeSetupError(error: unknown): string | undefined {
  if (!isNotionClientError(error)) return undefined;
  if (error.code === APIErrorCode.ObjectNotFound) {
    return "Notion can't find that page. Open it, then ••• → Connections → add the bot's integration, and try again.";
  }
  if (error.code === APIErrorCode.Unauthorized) return 'Notion rejected the token: check NOTION_TOKEN.';
  if (error.code === APIErrorCode.RestrictedResource) {
    return 'The integration lacks a capability: it needs Read, Update and Insert content.';
  }
  return undefined;
}
