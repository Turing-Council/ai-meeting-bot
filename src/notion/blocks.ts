import type { BlockObjectRequest } from '@notionhq/client';
import { formatOffset } from '../bot/format.js';
import type { Material, SessionManifest } from '../sessions/manifest.js';
import type { Summary } from '../summarize/summary.js';
import type { TranscriptSegment } from '../transcript/transcript.js';
import { bullet, heading, paragraph, richText, type TextRun } from './rich-text.js';

export interface BodyInput {
  manifest: SessionManifest;
  summary?: Summary | undefined;
  turns?: readonly TranscriptSegment[] | undefined;
  /** Upload ID of `mixed.ogg`, for the audio player. */
  recordingUpload?: string | undefined;
  /** Upload IDs of material files, by `Material.file`. */
  materialUploads?: ReadonlyMap<string, string>;
}

export interface MeetingBody {
  /** Top-level blocks, in page order (see transcriptToggleIndex for where the transcript goes). */
  blocks: BlockObjectRequest[];
  /** Paragraphs that go inside the transcript toggle, appended after it exists. */
  transcript: BlockObjectRequest[];
}

const TRANSCRIPT_HEADING = 'Full transcript';

/**
 * The meeting page body: Summary → Decisions → Action items → Open questions → Bookmarks →
 * Materials → Recording → Full transcript (toggle). Sections with nothing in them are left out.
 */
export function meetingBody(input: BodyInput): MeetingBody {
  const { manifest, summary } = input;
  const blocks: BlockObjectRequest[] = [];

  if (summary) {
    blocks.push(heading('Summary'));
    if (summary.tldr) {
      blocks.push({ type: 'callout', callout: { rich_text: richText(summary.tldr), icon: { type: 'emoji', emoji: '💡' } } });
    }
    blocks.push(...summary.keyPoints.map((point) => bullet(point)));
    section(blocks, 'Decisions', summary.decisions.map((d) => bullet(d)));
    section(
      blocks,
      'Action items',
      summary.actionItems.map((item) => ({
        type: 'to_do',
        to_do: {
          checked: false,
          rich_text: richText(
            item.task,
            ...(item.owner ? [{ text: ` — ${item.owner}`, bold: true }] : []),
            ...(item.due ? [{ text: ` (due ${item.due})`, color: 'gray' as const }] : []),
          ),
        },
      })),
    );
    section(blocks, 'Open questions', summary.openQuestions.map((q) => bullet(q)));
  }

  section(
    blocks,
    'Bookmarks',
    manifest.bookmarks.map((b) => bullet({ text: `[${formatOffset(b.atMs)}] `, color: 'gray' }, b.text, { text: ` — ${b.by.name}`, color: 'gray' })),
  );
  section(blocks, 'Materials', (manifest.materials ?? []).flatMap((m) => materialBlock(m, input.materialUploads)));

  if (input.recordingUpload) {
    blocks.push(heading('Recording'), { type: 'audio', audio: { type: 'file_upload', file_upload: { id: input.recordingUpload } } });
  }

  const turns = input.turns ?? [];
  if (turns.length > 0) blocks.push(heading(TRANSCRIPT_HEADING, true));

  blocks.push(paragraph({ text: `Recorded by Turing Voice Bot · session ${manifest.id}`, color: 'gray' }));
  return { blocks, transcript: turns.map(transcriptParagraph) };
}

/** Index of the transcript toggle in `MeetingBody.blocks`, or -1. */
export function transcriptToggleIndex(body: MeetingBody): number {
  return body.blocks.findIndex((b) => b.type === 'heading_2' && 'heading_2' in b && b.heading_2.is_toggleable === true);
}

function section(blocks: BlockObjectRequest[], title: string, items: BlockObjectRequest[]): void {
  if (items.length > 0) blocks.push(heading(title), ...items);
}

function transcriptParagraph(turn: TranscriptSegment): BlockObjectRequest {
  return paragraph({ text: `[${formatOffset(turn.startMs)}] ${turn.speaker}: `, bold: true }, turn.text);
}

function materialBlock(material: Material, uploads: ReadonlyMap<string, string> | undefined): BlockObjectRequest[] {
  const caption: TextRun[] = [{ text: `${material.by.name} at ${formatOffset(material.atMs)}`, color: 'gray' }];
  const upload = material.file ? uploads?.get(material.file) : undefined;
  if (upload) {
    const fileUpload = { type: 'file_upload' as const, file_upload: { id: upload } };
    if (material.contentType?.startsWith('image/')) return [{ type: 'image', image: { ...fileUpload, caption: richText(...caption) } }];
    return [{ type: 'file', file: { ...fileUpload, name: material.name.slice(0, 900), caption: richText(...caption) } }];
  }
  if (material.url) {
    if (material.kind === 'link') return [{ type: 'bookmark', bookmark: { url: material.url, caption: richText(...caption) } }];
    // A file that couldn't be kept (too large, or the download failed): link to it instead.
    return [bullet({ text: material.name, link: material.url }, { text: ` — ${caption[0]?.text ?? ''}`, color: 'gray' })];
  }
  return [];
}
