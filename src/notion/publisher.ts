import type { Logger } from '../logger.js';
import type { PipelineListener } from '../pipeline/runner.js';
import type { SessionManifest } from '../sessions/manifest.js';
import type { CreatedPage, NotionApi } from './api.js';
import { meetingProperties, statusValue, type MeetingUploads } from './properties.js';
import { MEETING, type MeetingStatus } from './schema.js';
import type { NotionSettings, NotionSetup } from './settings.js';

/** Creates meeting pages and keeps their Status in step with the session. */
export class NotionPublisher {
  /** Last status written per page, so repeated progress updates cost no API calls. */
  private readonly statuses = new Map<string, MeetingStatus>();

  constructor(
    readonly api: NotionApi,
    readonly settings: NotionSettings,
    private readonly logger: Logger,
  ) {}

  /** The saved setup; throws a clear error if `/meeting setup` hasn't been run. */
  async requireSetup(): Promise<NotionSetup> {
    const setup = await this.settings.get();
    if (!setup) throw new Error('Notion is not set up yet: run /meeting setup in Discord, then retry.');
    return setup;
  }

  async createMeetingPage(manifest: SessionManifest, status: MeetingStatus): Promise<CreatedPage> {
    const setup = await this.requireSetup();
    const page = await this.api.createPage({
      parent: { type: 'data_source_id', data_source_id: setup.meetings.dataSourceId },
      icon: { type: 'emoji', emoji: '🎙️' },
      properties: meetingProperties(manifest, status, setup.meetings.statusType),
    });
    this.statuses.set(page.id, status);
    return page;
  }

  /**
   * At `/meeting start`: creates the page in the background. `attach` stores it on the live
   * session; if the session already ended, the page is trashed and processing creates a new one.
   * Notion problems are logged, never thrown: they must not affect the recording.
   */
  async startMeeting(manifest: SessionManifest, attach: (page: CreatedPage) => Promise<boolean>): Promise<void> {
    if (!(await this.settings.get())) {
      this.logger.warn('Notion is not set up yet: run /meeting setup. This meeting will be published once it is.', { sessionId: manifest.id });
      return;
    }
    try {
      const page = await this.createMeetingPage(manifest, 'Recording');
      if (!(await attach(page))) await this.api.trashPage(page.id);
    } catch (error) {
      this.logger.warn('Could not create the Notion page; processing will retry', { sessionId: manifest.id, error });
    }
  }

  /** Writes the final properties (duration, participants, files) and marks the page Done. */
  async completeMeetingPage(manifest: SessionManifest, uploads: MeetingUploads): Promise<void> {
    const pageId = manifest.notion?.pageId;
    if (!pageId) throw new Error('The session has no Notion page');
    const setup = await this.requireSetup();
    await this.api.updatePage({ page_id: pageId, properties: meetingProperties(manifest, 'Done', setup.meetings.statusType, uploads) });
    this.statuses.set(pageId, 'Done');
  }

  async setStatus(manifest: SessionManifest, status: MeetingStatus): Promise<void> {
    const pageId = manifest.notion?.pageId;
    if (!pageId || this.statuses.get(pageId) === status) return;
    const setup = await this.requireSetup();
    await this.api.updatePage({ page_id: pageId, properties: { [MEETING.status]: statusValue(setup.meetings.statusType, status) } });
    this.statuses.set(pageId, status);
  }

  /**
   * Mirrors processing on the page: `Processing` while it runs, `Failed` if a step failed.
   * `Done` is written by the publish step itself, and nothing here overrides it.
   */
  statusListener(): PipelineListener {
    return async (manifest, finished) => {
      if (manifest.processing?.publish?.status === 'done') return;
      const failed = Object.values(manifest.processing ?? {}).some((state) => state.status === 'failed');
      const status: MeetingStatus | undefined = !finished ? 'Processing' : failed ? 'Failed' : undefined;
      if (!status) return;
      try {
        await this.setStatus(manifest, status);
      } catch (error) {
        this.logger.warn('Could not update the Notion status', { sessionId: manifest.id, status, error });
      }
    };
  }
}
