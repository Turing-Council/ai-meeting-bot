import { AttachmentBuilder, type Client } from 'discord.js';
import type { Logger } from '../logger.js';
import { loadSummary } from '../pipeline/index.js';
import type { PipelineListener } from '../pipeline/runner.js';
import type { SessionStore } from '../sessions/store.js';
import type { SessionManifest } from '../sessions/manifest.js';
import { buildPanel, type PanelExtras } from './panel.js';

export interface PanelUpdate extends PanelExtras {
  /** Files to attach, replacing any attached earlier (e.g. the transcript after a retry). */
  attachments?: { file: string; name: string }[] | undefined;
}

/**
 * Edits a session's control panel message. Goes through the channel rather than an
 * interaction token, because interaction tokens expire after 15 minutes.
 */
export class PanelUpdater {
  constructor(
    private readonly client: Client,
    private readonly logger: Logger,
  ) {}

  async update(manifest: SessionManifest, update: PanelUpdate = {}): Promise<void> {
    if (!manifest.panelChannelId || !manifest.panelMessageId) return;
    try {
      const channel = await this.client.channels.fetch(manifest.panelChannelId);
      if (!channel?.isTextBased()) return;
      const message = await channel.messages.fetch(manifest.panelMessageId);
      const panel = buildPanel(manifest, update);
      if (update.attachments) {
        const files = update.attachments.map((a) => new AttachmentBuilder(a.file, { name: a.name }));
        try {
          await message.edit({ ...panel, files, attachments: [] });
          return;
        } catch (error) {
          // Usually a missing Attach Files permission: still show the results, just without the file.
          this.logger.warn('Could not attach files to the control panel', { sessionId: manifest.id, error });
        }
      }
      await message.edit(panel);
    } catch (error) {
      this.logger.debug('Could not update control panel', { sessionId: manifest.id, error });
    }
  }
}

/**
 * Mirrors processing on the panel: progress while it runs, then the summary and the transcript
 * file once the run ends (the transcript only if transcription succeeded).
 */
export function panelProcessingListener(store: SessionStore, panel: Pick<PanelUpdater, 'update'>): PipelineListener {
  return async (manifest, finished) => {
    if (!finished) return panel.update(manifest);
    const transcript = manifest.processing?.transcribe?.status === 'done' ? manifest.transcriptFile : undefined;
    await panel.update(manifest, {
      summary: await loadSummary(store, manifest),
      attachments: transcript ? [{ file: store.resolve(manifest.id, transcript), name: 'transcript.md' }] : undefined,
    });
  };
}
