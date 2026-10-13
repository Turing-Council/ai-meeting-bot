import { AttachmentBuilder, type Client } from 'discord.js';
import type { Logger } from '../logger.js';
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
        await message.edit({ ...panel, files, attachments: [] });
      } else {
        await message.edit(panel);
      }
    } catch (error) {
      this.logger.debug('Could not update control panel', { sessionId: manifest.id, error });
    }
  }
}
