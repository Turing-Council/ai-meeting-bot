import { stat } from 'node:fs/promises';
import { meetingBody, transcriptToggleIndex } from '../notion/blocks.js';
import { actionItemProperties } from '../notion/properties.js';
import type { NotionPublisher } from '../notion/publisher.js';
import { batches } from '../notion/rich-text.js';
import { Summary } from '../summarize/summary.js';
import { Transcript } from '../transcript/transcript.js';
import { readJsonFile } from './files.js';
import type { PipelineStep, StepContext } from './runner.js';

/**
 * Publishes the meeting to Notion: page properties, the attached recording and transcript,
 * the page body and the action items. Safe to re-run: it replaces only the blocks it wrote
 * before (notes people added stay), and creates action items only once. Progress that would
 * otherwise be duplicated is checkpointed as soon as it exists in Notion.
 */
export function publishStep({ publisher }: { publisher: NotionPublisher }): PipelineStep {
  const api = publisher.api;
  return {
    name: 'publish',
    // Runs last: after whichever of these are configured.
    needs: ['mix', 'transcribe', 'summarize'],

    async run({ manifest, resolve, logger, checkpoint }: StepContext) {
      const setup = await publisher.requireSetup();

      // 1. The page: normally created at /meeting start.
      if (!manifest.notion) {
        const page = await publisher.createMeetingPage(manifest, 'Processing');
        manifest.notion = { pageId: page.id, pageUrl: page.url, bodyBlockIds: [], actionItemIds: [] };
        await checkpoint();
      }
      const notion = manifest.notion;

      // 2. Files. Uploads expire unless attached within an hour, so they are redone every run.
      const upload = async (relative: string | undefined, contentType: string, filename: string) =>
        relative && (await exists(resolve(relative))) ? api.uploadFile(resolve(relative), contentType, filename) : undefined;
      const uploads = {
        recording: await upload(manifest.mixedFile, 'audio/ogg', 'recording.ogg'),
        transcript: await upload(manifest.transcriptFile, 'text/markdown', 'transcript.md'),
      };
      const materialUploads = new Map<string, string>();
      for (const material of manifest.materials ?? []) {
        if (!material.file) continue;
        try {
          // Discord may send `text/plain; charset=utf-8`; Notion wants the bare type.
          const contentType = material.contentType?.split(';')[0]?.trim() || 'application/octet-stream';
          const id = await upload(material.file, contentType, material.name);
          if (id) materialUploads.set(material.file, id);
        } catch (error) {
          // One unsupported file shouldn't block the meeting page; it's listed as a link instead.
          logger.warn('Could not upload a material file', { file: material.file, error });
        }
      }

      // 3. The body: remove what the bot wrote last time, then write it again.
      const summary = manifest.summaryFile ? await readJsonFile(resolve(manifest.summaryFile), Summary) : undefined;
      const transcript = manifest.transcriptDataFile ? await readJsonFile(resolve(manifest.transcriptDataFile), Transcript) : undefined;
      const body = meetingBody({
        manifest,
        summary,
        turns: transcript?.turns,
        recordingUpload: uploads.recording,
        materialUploads,
      });

      for (const blockId of [...notion.bodyBlockIds]) {
        await api.deleteBlock(blockId);
        notion.bodyBlockIds.shift();
      }
      await checkpoint();
      for (const batch of batches(body.blocks)) {
        notion.bodyBlockIds.push(...(await api.appendBlocks(notion.pageId, batch)));
        await checkpoint();
      }
      const toggleId = notion.bodyBlockIds[transcriptToggleIndex(body)];
      if (toggleId) {
        for (const batch of batches(body.transcript)) await api.appendBlocks(toggleId, batch);
      }

      // 4. Action items, each created once: rows already created (and maybe edited by people)
      // are left alone on a retry, and a run cut short continues where it stopped.
      for (const item of (summary?.actionItems ?? []).slice(notion.actionItemIds.length)) {
        const page = await api.createPage({
          parent: { type: 'data_source_id', data_source_id: setup.actionItems.dataSourceId },
          properties: actionItemProperties(item, notion.pageId, setup.actionItems.statusType),
        });
        notion.actionItemIds.push(page.id);
        await checkpoint();
      }

      // 5. Final properties and Status = Done.
      await publisher.completeMeetingPage(manifest, uploads);
      logger.info('Published to Notion', { page: notion.pageUrl, blocks: notion.bodyBlockIds.length, actionItems: notion.actionItemIds.length });
    },

    /** Starting over (`--force`): the same page is reused, but its action items are recreated. */
    async reset({ manifest, checkpoint }: StepContext) {
      const notion = manifest.notion;
      if (!notion) return;
      for (const id of [...notion.actionItemIds]) {
        await api.trashPage(id);
        notion.actionItemIds.shift();
      }
      await checkpoint();
    },
  };
}

const exists = (file: string) => stat(file).then((s) => s.size > 0, () => false);
