import type { CreateDatabaseParameters } from '@notionhq/client';

/** Property names in the Meetings database. */
export const MEETING = {
  title: 'Title',
  date: 'Date',
  duration: 'Duration (min)',
  channel: 'Channel',
  participants: 'Participants',
  type: 'Type',
  status: 'Status',
  trigger: 'Trigger',
  recording: 'Recording',
  transcript: 'Transcript',
  /** The other side of Action Items → Meeting. */
  actionItems: 'Action items',
} as const;

/** Property names in the Action Items database. */
export const ACTION_ITEM = {
  task: 'Task',
  owner: 'Owner',
  due: 'Due',
  status: 'Status',
  meeting: 'Meeting',
} as const;

export const MEETING_STATUSES = ['Recording', 'Processing', 'Done', 'Failed'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const ACTION_ITEM_STATUSES = ['To do', 'Doing', 'Done'] as const;

/**
 * How a database's Status column is stored. Notion's own "Status" type is preferred; if the API
 * refuses to create one, setup falls back to a Select with the same options.
 */
export type StatusType = 'status' | 'select';

type Properties = NonNullable<NonNullable<CreateDatabaseParameters['initial_data_source']>['properties']>;
type SelectColor = 'default' | 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red';

const MEETING_STATUS_COLORS: Record<MeetingStatus, SelectColor> = {
  Recording: 'red',
  Processing: 'blue',
  Done: 'green',
  Failed: 'gray',
};
const ACTION_ITEM_STATUS_COLORS: Record<(typeof ACTION_ITEM_STATUSES)[number], SelectColor> = {
  'To do': 'gray',
  Doing: 'blue',
  Done: 'green',
};

function statusProperty(statusType: StatusType, colors: Record<string, SelectColor>): Properties[string] {
  const options = Object.entries(colors).map(([name, color]) => ({ name, color }));
  return statusType === 'status' ? { status: { options } } : { select: { options } };
}

export function meetingsDatabase(parentPageId: string, statusType: StatusType): CreateDatabaseParameters {
  return {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: 'Meetings' } }],
    icon: { type: 'emoji', emoji: '🎙️' },
    initial_data_source: {
      properties: {
        [MEETING.title]: { title: {} },
        [MEETING.date]: { date: {} },
        [MEETING.duration]: { number: { format: 'number' } },
        [MEETING.channel]: { select: { options: [] } },
        [MEETING.participants]: { multi_select: { options: [] } },
        [MEETING.type]: { multi_select: { options: [] } },
        [MEETING.status]: statusProperty(statusType, MEETING_STATUS_COLORS),
        [MEETING.trigger]: { select: { options: [{ name: 'Manual', color: 'default' }, { name: 'Auto', color: 'purple' }] } },
        [MEETING.recording]: { files: {} },
        [MEETING.transcript]: { files: {} },
      },
    },
  };
}

export function actionItemsDatabase(parentPageId: string, meetingsDataSourceId: string, statusType: StatusType): CreateDatabaseParameters {
  return {
    parent: { type: 'page_id', page_id: parentPageId },
    title: [{ type: 'text', text: { content: 'Action Items' } }],
    icon: { type: 'emoji', emoji: '📌' },
    initial_data_source: {
      properties: {
        [ACTION_ITEM.task]: { title: {} },
        [ACTION_ITEM.owner]: { rich_text: {} },
        [ACTION_ITEM.due]: { date: {} },
        [ACTION_ITEM.status]: statusProperty(statusType, ACTION_ITEM_STATUS_COLORS),
        [ACTION_ITEM.meeting]: {
          relation: {
            data_source_id: meetingsDataSourceId,
            type: 'dual_property',
            dual_property: { synced_property_name: MEETING.actionItems },
          },
        },
      },
    },
  };
}
