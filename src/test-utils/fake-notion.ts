import { APIErrorCode, APIResponseError, type BlockObjectRequest, type CreateDatabaseParameters, type CreatePageParameters, type UpdatePageParameters } from '@notionhq/client';
import type { CreatedDatabase, CreatedPage, NotionApi } from '../notion/api.js';

/** A Notion API error as the SDK throws it, so code under test sees the real error type. */
export function notionError(code: APIErrorCode, message: string, status = 400): APIResponseError {
  return new APIResponseError({ code, status, message, headers: new Headers(), rawBodyText: '', additional_data: undefined, request_id: undefined });
}

export interface FakePage {
  params: CreatePageParameters;
  properties: Record<string, unknown>;
  trashed: boolean;
}

/**
 * In-memory Notion: keeps databases, pages (with merged property updates), a block tree and
 * uploads. `failOn` makes the nth call of a method throw, to test retries and partial failures.
 */
export class FakeNotionApi implements NotionApi {
  readonly databases: CreateDatabaseParameters[] = [];
  readonly pages = new Map<string, FakePage>();
  /** Parent ID (page or block) → child block IDs, in order. */
  readonly children = new Map<string, string[]>();
  readonly blocks = new Map<string, BlockObjectRequest>();
  readonly uploads: { file: string; contentType: string; filename: string | undefined; id: string }[] = [];
  readonly missingDataSources = new Set<string>();
  readonly calls: string[] = [];
  private nextId = 1;
  private readonly failures: { method: keyof NotionApi; callNumber: number; error: Error }[] = [];
  private readonly callCounts = new Map<string, number>();

  /** Makes the `callNumber`-th call (1-based, counted from now) of `method` throw `error`. */
  failOn(method: keyof NotionApi, error: Error = new Error(`${method} failed`), callNumber = 1): void {
    this.failures.push({ method, callNumber: (this.callCounts.get(method) ?? 0) + callNumber, error });
  }

  /** Block content of a page or block, depth-first, as `type: text` lines (nested ones indented). */
  outline(parentId: string, depth = 0): string[] {
    return (this.children.get(parentId) ?? []).flatMap((id) => {
      const block = this.blocks.get(id) as BlockObjectRequest;
      const type = blockType(block);
      const body = (block as unknown as Record<string, { rich_text?: { text?: { content: string } }[] }>)[type];
      const text = body?.rich_text?.map((t) => t.text?.content ?? '').join('') ?? '';
      return [`${'  '.repeat(depth)}${type}: ${text}`, ...this.outline(id, depth + 1)];
    });
  }

  async createDatabase(params: CreateDatabaseParameters): Promise<CreatedDatabase> {
    this.record('createDatabase');
    this.databases.push(params);
    const n = this.nextId++;
    return { databaseId: `db-${n}`, dataSourceId: `ds-${n}`, url: `https://notion.test/db-${n}` };
  }

  async dataSourceExists(dataSourceId: string): Promise<boolean> {
    this.record('dataSourceExists');
    return !this.missingDataSources.has(dataSourceId);
  }

  async createPage(params: CreatePageParameters): Promise<CreatedPage> {
    this.record('createPage');
    const id = `page-${this.nextId++}`;
    this.pages.set(id, { params, properties: { ...(params.properties ?? {}) }, trashed: false });
    if (params.children) this.addChildren(id, params.children);
    return { id, url: `https://notion.test/${id}` };
  }

  async updatePage(params: UpdatePageParameters): Promise<void> {
    this.record('updatePage');
    const page = this.pages.get(params.page_id);
    if (!page) throw notionError(APIErrorCode.ObjectNotFound, 'page not found', 404);
    Object.assign(page.properties, params.properties ?? {});
    if (params.in_trash) page.trashed = true;
  }

  async appendBlocks(parentId: string, children: BlockObjectRequest[]): Promise<string[]> {
    this.record('appendBlocks');
    if (children.length > 100) throw notionError(APIErrorCode.ValidationError, 'children: at most 100');
    return this.addChildren(parentId, children);
  }

  async deleteBlock(blockId: string): Promise<void> {
    this.record('deleteBlock');
    for (const ids of this.children.values()) {
      const index = ids.indexOf(blockId);
      if (index >= 0) ids.splice(index, 1);
    }
  }

  async trashPage(pageId: string): Promise<void> {
    this.record('trashPage');
    const page = this.pages.get(pageId);
    if (page) page.trashed = true;
  }

  async uploadFile(file: string, contentType: string, filename?: string): Promise<string> {
    this.record('uploadFile');
    const id = `upload-${this.nextId++}`;
    this.uploads.push({ file, contentType, filename, id });
    return id;
  }

  private addChildren(parentId: string, children: BlockObjectRequest[], depth = 1): string[] {
    const ids = children.map((block) => {
      const id = `block-${this.nextId++}`;
      this.blocks.set(id, block);
      const nested = (block as unknown as Record<string, { children?: BlockObjectRequest[] }>)[blockType(block)]?.children;
      if (nested) {
        if (depth >= 2) throw notionError(APIErrorCode.ValidationError, 'children nested too deeply');
        this.addChildren(id, nested, depth + 1);
      }
      return id;
    });
    this.children.set(parentId, [...(this.children.get(parentId) ?? []), ...ids]);
    return ids;
  }

  private record(method: keyof NotionApi): void {
    const count = (this.callCounts.get(method) ?? 0) + 1;
    this.callCounts.set(method, count);
    this.calls.push(method);
    const failure = this.failures.findIndex((f) => f.method === method && f.callNumber === count);
    if (failure >= 0) {
      const [{ error }] = this.failures.splice(failure, 1) as unknown as [{ error: Error }];
      throw error;
    }
  }
}

/** A block request's type, from `type` or (when omitted) its one content key. */
export function blockType(block: BlockObjectRequest): string {
  return block.type ?? Object.keys(block).find((key) => key !== 'object' && key !== 'type') ?? 'unknown';
}
