import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = z.string().trim();
const list = z.array(text).catch([]).default([]).transform((items) => items.filter(Boolean));
const nullableText = z
  .string()
  .nullish()
  .transform((value) => value?.trim() || null);

const ActionItem = z
  .object({ task: text.min(1), owner: nullableText, due: nullableText })
  .transform((item) => {
    // Keep a due date the model couldn't turn into YYYY-MM-DD ("next sprint") as part of the task.
    if (item.due && !ISO_DATE.test(item.due)) return { ...item, task: `${item.task} (due: ${item.due})`, due: null };
    return item;
  });

/**
 * The structured meeting summary (`summary.json`). Parsing is lenient on purpose: missing
 * lists become empty and malformed action items are dropped, so one sloppy field from the
 * model doesn't throw away the whole summary.
 */
export const Summary = z.object({
  tldr: text.default(''),
  keyPoints: list,
  decisions: list,
  actionItems: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((items) => items.flatMap((item) => {
      const parsed = ActionItem.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })),
  openQuestions: list,
});
export type Summary = z.infer<typeof Summary>;
export type ActionItem = Summary['actionItems'][number];

export const EMPTY_SUMMARY: Summary = { tldr: '', keyPoints: [], decisions: [], actionItems: [], openQuestions: [] };

/** The JSON shape described to the model in the prompt. */
export const SUMMARY_SHAPE = `{
  "tldr": string,              // 1–3 sentences: what the meeting was about and its outcome
  "keyPoints": string[],       // the main topics and facts discussed
  "decisions": string[],       // what was agreed or decided
  "actionItems": [{ "task": string, "owner": string | null, "due": "YYYY-MM-DD" | null }],
  "openQuestions": string[]    // unresolved questions and topics left for later
}`;
