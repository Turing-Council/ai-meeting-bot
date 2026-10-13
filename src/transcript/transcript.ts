import { z } from 'zod';
import { formatOffset } from '../bot/format.js';
import type { SessionManifest } from '../sessions/manifest.js';

/** One utterance on the meeting timeline. Times are ms from the meeting start. */
export const TranscriptSegment = z.object({
  speakerId: z.string(),
  speaker: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

/** `transcript.json`: the machine-readable transcript, input for summaries and Notion. */
export const Transcript = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  /** Speaker turns in time order (consecutive segments by the same person are merged). */
  turns: z.array(TranscriptSegment),
});
export type Transcript = z.infer<typeof Transcript>;

/** Consecutive segments by the same speaker closer than this become one turn. */
const SAME_TURN_GAP_MS = 3_000;
/** …unless the turn would get longer than this, to keep timestamps useful. */
const MAX_TURN_MS = 120_000;

/** Interleaves every speaker's segments by time and joins each person's consecutive lines into turns. */
export function mergeSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const turns: TranscriptSegment[] = [];
  for (const segment of sorted) {
    const text = segment.text.trim();
    if (!text) continue;
    const last = turns.at(-1);
    if (
      last &&
      last.speakerId === segment.speakerId &&
      segment.startMs - last.endMs <= SAME_TURN_GAP_MS &&
      segment.endMs - last.startMs <= MAX_TURN_MS
    ) {
      last.text = `${last.text} ${text}`;
      last.endMs = Math.max(last.endMs, segment.endMs);
    } else {
      turns.push({ ...segment, text });
    }
  }
  return turns;
}

/** `[00:12:31] Alice: …` lines, the format the summarizer reads. */
export function transcriptLines(turns: readonly TranscriptSegment[]): string[] {
  return turns.map((turn) => `[${formatOffset(turn.startMs)}] ${turn.speaker}: ${turn.text}`);
}

/**
 * `transcript.md`: a readable transcript with a short header, attached to the panel and (M3)
 * Notion. Bookmarks appear as quotes at the moment they were made.
 */
export function renderTranscriptMarkdown(manifest: SessionManifest, turns: readonly TranscriptSegment[]): string {
  const header = [
    `# ${manifest.title}`,
    '',
    `- **Date:** ${manifest.startedAt.slice(0, 16).replace('T', ' ')} UTC`,
    `- **Channel:** ${manifest.voiceChannelName}`,
    `- **Participants:** ${manifest.participants.map((p) => p.name).join(', ') || '—'}`,
    '',
    '## Transcript',
    '',
  ];
  const entries = [
    ...turns.map((turn) => ({ atMs: turn.startMs, line: `**[${formatOffset(turn.startMs)}] ${turn.speaker}:** ${turn.text}\n` })),
    ...manifest.bookmarks.map((b) => ({ atMs: b.atMs, line: `> 📝 **[${formatOffset(b.atMs)}] Bookmark:** ${b.text} (${b.by.name})\n` })),
  ];
  // Stable sort: at equal times a bookmark follows the line it was made during.
  entries.sort((a, b) => a.atMs - b.atMs);
  const body = turns.length > 0 ? entries.map((e) => e.line) : ['_No speech was transcribed._\n', ...entries.map((e) => e.line)];
  return `${[...header, ...body].join('\n')}`;
}
