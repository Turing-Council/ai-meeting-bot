import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeServer } from '../test-utils/http-server.js';
import { downloadFile, extractLinks, MAX_MATERIAL_BYTES, materialsFromMessage, safeFileName } from './materials.js';

describe('extractLinks', () => {
  it('finds links, without trailing punctuation or Discord brackets, once each', () => {
    expect(
      extractLinks(
        'See https://example.com/a, and <https://docs.test/x?y=1>. Also (https://example.com/a) and [doc](https://wiki.test/Page_(v2))',
      ),
    ).toEqual(['https://example.com/a', 'https://docs.test/x?y=1', 'https://wiki.test/Page_(v2)']);
    expect(extractLinks('no links here, just ftp://old.test')).toEqual([]);
  });

  it('makes file names safe', () => {
    expect(safeFileName('Q4 plan (final).pdf')).toBe('Q4_plan_final_.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('???')).toBe('_');
  });
});

describe('materialsFromMessage', () => {
  const by = { id: 'u1', name: 'Alice' };
  const message = {
    id: 'm1',
    content: 'Slides: https://slides.test/1 and https://known.test',
    createdTimestamp: 65_000,
    by,
    attachments: [
      { name: 'plan.pdf', url: 'https://cdn.test/plan.pdf', size: 1000, contentType: 'application/pdf' },
      { name: 'video.mp4', url: 'https://cdn.test/video.mp4', size: MAX_MATERIAL_BYTES + 1, contentType: 'video/mp4' },
    ],
  };

  it('records new links and attachments at the meeting time, and plans downloads for small files', () => {
    const { materials, downloads } = materialsFromMessage(message, 5_000, new Set(['https://known.test/']));
    expect(materials.map((m) => [m.kind, m.name, m.atMs])).toEqual([
      ['link', 'https://slides.test/1', 60_000],
      ['file', 'plan.pdf', 60_000],
      ['file', 'video.mp4', 60_000],
    ]);
    expect(downloads).toEqual([{ material: materials[1], url: 'https://cdn.test/plan.pdf', file: 'materials/m1-0-plan.pdf' }]);
    expect(materials[2]?.file).toBeUndefined(); // too big: stays a link
  });
});

describe('downloadFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tvb-dl-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('saves the file', async () => {
    const server = await startFakeServer(() => ({ body: 'file contents' }));
    try {
      const dest = path.join(dir, 'a.txt');
      expect(await downloadFile(`${server.baseUrl}/a.txt`, dest)).toBe(13);
      expect(await readFile(dest, 'utf8')).toBe('file contents');
    } finally {
      await server.close();
    }
  });

  it('refuses files over the limit and leaves nothing behind', async () => {
    const server = await startFakeServer(() => ({ body: 'x'.repeat(5000) }));
    try {
      const dest = path.join(dir, 'big.bin');
      await expect(downloadFile(`${server.baseUrl}/big`, dest, 1000)).rejects.toThrow(/larger than 1000 bytes/);
      await expect(stat(dest)).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('reports failed downloads', async () => {
    const server = await startFakeServer(() => ({ status: 404, body: 'gone' }));
    try {
      await expect(downloadFile(`${server.baseUrl}/x`, path.join(dir, 'x'))).rejects.toThrow(/status 404/);
    } finally {
      await server.close();
    }
  });
});
