import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  APIErrorCode,
  Client,
  isNotionClientError,
  type BlockObjectRequest,
  type CreateDatabaseParameters,
  type CreatePageParameters,
  type UpdatePageParameters,
} from '@notionhq/client';

/** The API version the request shapes in this module are written for. */
export const NOTION_VERSION = '2025-09-03';

/** Above this size an upload is sent in parts. */
export const SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024;
/** Part size for multi-part uploads (Notion accepts 5–20 MB per part, last part smaller). */
export const PART_BYTES = 10 * 1024 * 1024;

export interface CreatedDatabase {
  databaseId: string;
  dataSourceId: string;
  url: string;
}

export interface CreatedPage {
  id: string;
  url: string;
}

/**
 * The few Notion operations the bot uses, behind an interface so the publishing logic can be
 * tested against a fake.
 */
export interface NotionApi {
  createDatabase(params: CreateDatabaseParameters): Promise<CreatedDatabase>;
  /** False when the data source is gone or no longer shared with the integration. */
  dataSourceExists(dataSourceId: string): Promise<boolean>;
  createPage(params: CreatePageParameters): Promise<CreatedPage>;
  updatePage(params: UpdatePageParameters): Promise<void>;
  /** Appends blocks (at most 100) and returns the IDs of the created top-level blocks, in order. */
  appendBlocks(parentId: string, children: BlockObjectRequest[]): Promise<string[]>;
  /** Deletes a block; a block that is already gone is not an error. */
  deleteBlock(blockId: string): Promise<void>;
  /** Moves a page to the trash; a page that is already gone is not an error. */
  trashPage(pageId: string): Promise<void>;
  /** Uploads a file and returns the file upload ID, to attach within the hour. */
  uploadFile(file: string, contentType: string, filename?: string): Promise<string>;
}

/** Byte ranges for a multi-part upload: `PART_BYTES` each, the last one shorter. */
export function partRanges(size: number, partBytes = PART_BYTES): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < size; start += partBytes) ranges.push({ start, end: Math.min(start + partBytes, size) });
  return ranges;
}

/** `NotionApi` over the official SDK, which also retries rate limits and server errors. */
export class SdkNotionApi implements NotionApi {
  private readonly client: Client;

  constructor(token: string) {
    this.client = new Client({ auth: token, notionVersion: NOTION_VERSION });
  }

  async createDatabase(params: CreateDatabaseParameters): Promise<CreatedDatabase> {
    const database = await this.client.databases.create(params);
    const dataSourceId = 'data_sources' in database ? database.data_sources[0]?.id : undefined;
    if (!dataSourceId) throw new Error('Notion created the database but returned no data source');
    return { databaseId: database.id, dataSourceId, url: 'url' in database ? database.url : '' };
  }

  async dataSourceExists(dataSourceId: string): Promise<boolean> {
    try {
      await this.client.dataSources.retrieve({ data_source_id: dataSourceId });
      return true;
    } catch (error) {
      if (isNotionClientError(error) && error.code === APIErrorCode.ObjectNotFound) return false;
      throw error;
    }
  }

  async createPage(params: CreatePageParameters): Promise<CreatedPage> {
    const page = await this.client.pages.create(params);
    return { id: page.id, url: 'url' in page ? page.url : '' };
  }

  async updatePage(params: UpdatePageParameters): Promise<void> {
    await this.client.pages.update(params);
  }

  async appendBlocks(parentId: string, children: BlockObjectRequest[]): Promise<string[]> {
    const response = await this.client.blocks.children.append({ block_id: parentId, children });
    return response.results.map((block) => block.id);
  }

  async deleteBlock(blockId: string): Promise<void> {
    await ignoreGone(this.client.blocks.delete({ block_id: blockId }));
  }

  async trashPage(pageId: string): Promise<void> {
    await ignoreGone(this.client.pages.update({ page_id: pageId, in_trash: true }));
  }

  async uploadFile(file: string, contentType: string, filename = path.basename(file)): Promise<string> {
    const { size } = await stat(file);
    if (size <= SINGLE_PART_MAX_BYTES) {
      const upload = await this.client.fileUploads.create({ mode: 'single_part', filename, content_type: contentType });
      const data = new Blob([await readRange(file, 0, size)], { type: contentType });
      await this.client.fileUploads.send({ file_upload_id: upload.id, file: { filename, data } });
      return upload.id;
    }

    const ranges = partRanges(size);
    const upload = await this.client.fileUploads.create({
      mode: 'multi_part',
      filename,
      content_type: contentType,
      number_of_parts: ranges.length,
    });
    // One part in memory at a time; parts are sent in order.
    for (const [index, range] of ranges.entries()) {
      const data = new Blob([await readRange(file, range.start, range.end)], { type: contentType });
      await this.client.fileUploads.send({
        file_upload_id: upload.id,
        file: { filename, data },
        part_number: String(index + 1),
      });
    }
    await this.client.fileUploads.complete({ file_upload_id: upload.id });
    return upload.id;
  }
}

async function readRange(file: string, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  const handle = await open(file, 'r');
  try {
    const buffer = new Uint8Array(end - start);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

async function ignoreGone(request: Promise<unknown>): Promise<void> {
  try {
    await request;
  } catch (error) {
    if (isNotionClientError(error) && error.code === APIErrorCode.ObjectNotFound) return;
    // Deleting/trashing something already archived reports a validation error.
    if (isNotionClientError(error) && error.code === APIErrorCode.ValidationError && /archived|trash/i.test(error.message)) return;
    throw error;
  }
}
