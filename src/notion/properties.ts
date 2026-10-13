import type { CreatePageParameters } from '@notionhq/client';
import type { SessionManifest } from '../sessions/manifest.js';
import type { ActionItem } from '../summarize/summary.js';
import { optionName, richText } from './rich-text.js';
import { ACTION_ITEM, MEETING, type MeetingStatus, type StatusType } from './schema.js';

type Properties = NonNullable<CreatePageParameters['properties']>;

export interface MeetingUploads {
  recording?: string | undefined;
  transcript?: string | undefined;
}

export function statusValue(statusType: StatusType, name: string): Properties[string] {
  return statusType === 'status' ? { status: { name } } : { select: { name } };
}

/**
 * Meeting page properties. At start only what is known then is set; after processing the
 * duration, final participants and the uploaded files are added.
 */
export function meetingProperties(
  manifest: SessionManifest,
  status: MeetingStatus,
  statusType: StatusType,
  uploads: MeetingUploads = {},
): Properties {
  const participants = [...new Set(manifest.participants.map((p) => optionName(p.name)))].slice(0, 100);
  const properties: Properties = {
    [MEETING.title]: { title: richText(manifest.title) },
    [MEETING.date]: { date: { start: manifest.startedAt, ...(manifest.endedAt ? { end: manifest.endedAt } : {}) } },
    [MEETING.channel]: { select: { name: optionName(manifest.voiceChannelName) } },
    [MEETING.participants]: { multi_select: participants.map((name) => ({ name })) },
    [MEETING.status]: statusValue(statusType, status),
    [MEETING.trigger]: { select: { name: manifest.trigger === 'auto' ? 'Auto' : 'Manual' } },
  };
  if (manifest.type) properties[MEETING.type] = { multi_select: [{ name: optionName(manifest.type) }] };
  if (manifest.durationMs !== undefined) {
    properties[MEETING.duration] = { number: Math.round(manifest.durationMs / 6000) / 10 };
  }
  if (uploads.recording) {
    properties[MEETING.recording] = { files: [{ type: 'file_upload', file_upload: { id: uploads.recording }, name: 'recording.ogg' }] };
  }
  if (uploads.transcript) {
    properties[MEETING.transcript] = { files: [{ type: 'file_upload', file_upload: { id: uploads.transcript }, name: 'transcript.md' }] };
  }
  return properties;
}

export function actionItemProperties(item: ActionItem, meetingPageId: string, statusType: StatusType): Properties {
  return {
    [ACTION_ITEM.task]: { title: richText(item.task) },
    [ACTION_ITEM.owner]: { rich_text: item.owner ? richText(item.owner) : [] },
    ...(item.due ? { [ACTION_ITEM.due]: { date: { start: item.due } } } : {}),
    [ACTION_ITEM.status]: statusValue(statusType, 'To do'),
    [ACTION_ITEM.meeting]: { relation: [{ id: meetingPageId }] },
  };
}
