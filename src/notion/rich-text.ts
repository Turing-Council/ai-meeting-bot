import type { BlockObjectRequest } from '@notionhq/client';

/** Notion's limits per rich-text item and per rich-text array. */
export const MAX_TEXT_CHARS = 2000;
const MAX_RICH_TEXT_ITEMS = 100;

export interface TextRun {
  text: string;
  bold?: boolean;
  color?: 'gray';
  link?: string;
}

type RichTextItem = {
  type: 'text';
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; color?: 'gray' };
};

/** Rich text from runs, each split into pieces of at most 2000 characters. */
export function richText(...runs: (TextRun | string)[]): RichTextItem[] {
  const items: RichTextItem[] = [];
  for (const run of runs.map((r) => (typeof r === 'string' ? { text: r } : r))) {
    for (let start = 0; start < run.text.length; start += MAX_TEXT_CHARS) {
      const item: RichTextItem = { type: 'text', text: { content: run.text.slice(start, start + MAX_TEXT_CHARS) } };
      if (run.link) item.text.link = { url: run.link };
      if (run.bold || run.color) item.annotations = { ...(run.bold ? { bold: true } : {}), ...(run.color ? { color: run.color } : {}) };
      items.push(item);
    }
  }
  return items.slice(0, MAX_RICH_TEXT_ITEMS);
}

/** Splits blocks into the batches of 100 Notion accepts per append. */
export function batches<T>(items: readonly T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const paragraph = (...runs: (TextRun | string)[]): BlockObjectRequest => ({
  type: 'paragraph',
  paragraph: { rich_text: richText(...runs) },
});

export const heading = (text: string, toggleable = false): BlockObjectRequest => ({
  type: 'heading_2',
  heading_2: { rich_text: richText(text), ...(toggleable ? { is_toggleable: true } : {}) },
});

export const bullet = (...runs: (TextRun | string)[]): BlockObjectRequest => ({
  type: 'bulleted_list_item',
  bulleted_list_item: { rich_text: richText(...runs) },
});

/** Text for select / multi-select options: no commas (Notion rejects them), at most 100 characters. */
export function optionName(text: string): string {
  return text.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || '—';
}
