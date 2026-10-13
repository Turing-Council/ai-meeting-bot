import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Material, Person } from './manifest.js';

/** Attachments bigger than this are linked instead of copied. */
export const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Links in a chat message, de-duplicated. Handles Discord's `<https://…>` (no preview) form and
 * trailing punctuation that isn't part of the link.
 */
export function extractLinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/<?(https?:\/\/[^\s<>]+)>?/gi)) {
    let url = match[1] ?? '';
    // Strip sentence punctuation, and closing parentheses the link didn't open.
    const unbalanced = (u: string) => u.endsWith(')') && u.split(')').length > u.split('(').length;
    while (/[.,!?;:'"]$/.test(url) || unbalanced(url)) url = url.slice(0, -1);
    try {
      links.add(new URL(url).toString());
    } catch {
      // not a valid URL after all
    }
  }
  return [...links];
}

/** A file name safe on any filesystem, keeping the extension. */
export function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-100);
  return cleaned || 'file';
}

/**
 * Downloads an attachment to `dest`, refusing anything over `maxBytes` (checked against the
 * header and while streaming, in case the header lies). Removes a partial file on failure.
 */
export async function downloadFile(url: string, dest: string, maxBytes = MAX_MATERIAL_BYTES): Promise<number> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`Download failed with status ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`File is larger than ${maxBytes} bytes`);

  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      callback(received > maxBytes ? new Error(`File is larger than ${maxBytes} bytes`) : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), limit, createWriteStream(dest));
  } catch (error) {
    await rm(dest, { force: true });
    throw error;
  }
  return received;
}

/** What the bot needs from a chat message (a subset of discord.js's Message). */
export interface ChatMessage {
  id: string;
  content: string;
  createdTimestamp: number;
  by: Person;
  attachments: { name: string; url: string; size: number; contentType: string | null }[];
}

export interface PlannedDownload {
  material: Material;
  url: string;
  /** Destination relative to the session directory. */
  file: string;
}

/**
 * Turns a chat message into materials: one per new link and one per attachment. Attachments
 * small enough to copy come with a planned download; until it finishes they only have a URL.
 */
export function materialsFromMessage(
  message: ChatMessage,
  sessionStartMs: number,
  knownLinks: ReadonlySet<string | undefined>,
): { materials: Material[]; downloads: PlannedDownload[] } {
  const base = { by: message.by, atMs: Math.max(0, message.createdTimestamp - sessionStartMs), messageId: message.id };
  const materials: Material[] = extractLinks(message.content)
    .filter((url) => !knownLinks.has(url))
    .map((url) => ({ kind: 'link', name: url, url, ...base }));
  const downloads: PlannedDownload[] = [];
  message.attachments.forEach((attachment, index) => {
    const material: Material = {
      kind: 'file',
      name: attachment.name,
      url: attachment.url,
      size: attachment.size,
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...base,
    };
    materials.push(material);
    if (attachment.size <= MAX_MATERIAL_BYTES) {
      const file = path.posix.join('materials', `${message.id}-${index}-${safeFileName(attachment.name)}`);
      downloads.push({ material, url: attachment.url, file });
    }
  });
  return { materials, downloads };
}
