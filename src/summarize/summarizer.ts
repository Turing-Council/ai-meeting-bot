import { createHash } from 'node:crypto';
import type { Logger } from '../logger.js';
import { extractJsonObject } from './json.js';
import { EMPTY_SUMMARY, Summary, SUMMARY_SHAPE } from './summary.js';
import type { ChatMessage, ChatModel } from './types.js';

export interface MeetingContext {
  title: string;
  type?: string | undefined;
  /** ISO timestamp of the meeting start (lets the model resolve "next Friday"). */
  startedAt: string;
  participants: string[];
  /** Moments participants flagged during the meeting (`/meeting note`), as `[mm:ss] text (by Name)`. */
  bookmarks: string[];
}

/** Stores intermediate results so a restarted job doesn't pay for the same LLM calls twice. */
export interface SummaryCache {
  get(key: string): Promise<Summary | undefined>;
  set(key: string, summary: Summary): Promise<void>;
}

export interface SummarizerOptions {
  model: ChatModel;
  /** Transcript characters per LLM call; longer meetings are summarized in parts and combined. */
  chunkChars: number;
  logger: Logger;
}

const SYSTEM_PROMPT = `You write meeting notes from transcripts of voice meetings.
Reply with one JSON object and nothing else, in this shape:
${SUMMARY_SHAPE}

Rules:
- Write in English, concisely. Use only what the transcript supports; never invent facts, names or dates.
- Transcript lines look like "[mm:ss] Speaker: text". Speech-to-text can mishear words; read for meaning.
- Bookmarks are moments participants flagged as important: make sure they are reflected.
- "owner" is the name of the participant who will do the task, exactly as written in the participant list, or null.
- "due" is a date in YYYY-MM-DD when one can be worked out from the meeting date, otherwise null.
- Use empty arrays when nothing fits a field.`;

/**
 * Turns a transcript into a structured Summary. Short meetings take one call; long ones are
 * split on line boundaries, each part is summarized ("map"), then the parts are combined ("reduce").
 */
export class Summarizer {
  constructor(private readonly options: SummarizerOptions) {}

  async summarize(context: MeetingContext, lines: readonly string[], cache?: SummaryCache): Promise<Summary> {
    if (lines.length === 0) return { ...EMPTY_SUMMARY, tldr: 'Nothing was said that could be transcribed.' };

    const parts = splitLines(lines, this.options.chunkChars);
    if (parts.length === 1) return this.ask(context, 'final', transcriptPrompt(parts[0] ?? []), cache);

    this.options.logger.info('Summarizing a long meeting in parts', { parts: parts.length });
    const partials: Summary[] = [];
    for (const [index, part] of parts.entries()) {
      const prompt = transcriptPrompt(part, `This is part ${index + 1} of ${parts.length} of the transcript. Summarize only this part.`);
      partials.push(await this.ask(context, `part-${index + 1}`, prompt, cache));
    }
    const combined = [
      `Below are summaries of ${partials.length} consecutive parts of the same meeting, in order.`,
      'Combine them into one summary of the whole meeting: merge duplicates, keep every decision and action item,',
      'and drop open questions that a later part answers.',
      '',
      ...partials.map((partial, i) => `Part ${i + 1}:\n${JSON.stringify(partial)}`),
    ].join('\n');
    return this.ask(context, 'combined', combined, cache);
  }

  /** One summary call. Results are cached by a hash of the exact prompt, so changed input is never served stale. */
  private async ask(context: MeetingContext, label: string, task: string, cache: SummaryCache | undefined): Promise<Summary> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${contextPrompt(context)}\n\n${task}` },
    ];
    const key = `${label}-${createHash('sha256').update(JSON.stringify(messages)).digest('hex').slice(0, 16)}`;
    const hit = await cache?.get(key);
    if (hit) return hit;
    const summary = await this.request(messages);
    await cache?.set(key, summary);
    return summary;
  }

  private async request(messages: ChatMessage[]): Promise<Summary> {
    const reply = await this.options.model.complete(messages, { json: true });
    const first = parseSummary(reply);
    if (first.ok) return first.summary;

    // One repair round: models usually fix their JSON when told what was wrong.
    this.options.logger.warn('LLM reply was not a valid summary; asking again', { error: first.error });
    const retry = await this.options.model.complete(
      [
        ...messages,
        { role: 'assistant', content: reply },
        { role: 'user', content: `That reply was not usable (${first.error}). Reply with only the JSON object in the requested shape.` },
      ],
      { json: true },
    );
    const second = parseSummary(retry);
    if (second.ok) return second.summary;
    throw new Error(`The LLM did not return a valid summary: ${second.error}`);
  }

  private async cached(cache: SummaryCache | undefined, key: string, run: () => Promise<Summary>): Promise<Summary> {
    const hit = await cache?.get(key);
    if (hit) return hit;
    const summary = await run();
    await cache?.set(key, summary);
    return summary;
  }
}

export function parseSummary(reply: string): { ok: true; summary: Summary } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJsonObject(reply);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = Summary.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  if (!parsed.data.tldr) return { ok: false, error: 'tldr is empty' };
  return { ok: true, summary: parsed.data };
}

/** Splits lines into parts of at most `maxChars` (a single overlong line gets a part of its own). */
export function splitLines(lines: readonly string[], maxChars: number): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > maxChars) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function contextPrompt(context: MeetingContext): string {
  return [
    `Meeting: ${context.title}`,
    ...(context.type ? [`Type: ${context.type}`] : []),
    `Date: ${context.startedAt.slice(0, 10)}`,
    `Participants: ${context.participants.join(', ') || 'unknown'}`,
    ...(context.bookmarks.length > 0 ? ['Bookmarks:', ...context.bookmarks.map((b) => `- ${b}`)] : []),
  ].join('\n');
}

function transcriptPrompt(lines: readonly string[], note?: string): string {
  return [...(note ? [note] : []), 'Transcript:', ...lines].join('\n');
}
