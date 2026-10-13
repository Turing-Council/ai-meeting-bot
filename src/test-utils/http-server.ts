import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A local HTTP server that records requests and answers with `respond` (JSON bodies). */
export async function startFakeServer(respond: (request: RecordedRequest, index: number) => FakeResponse) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(request);
      const reply = respond(request, requests.length - 1);
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Parses a recorded multipart/form-data request. */
export function parseForm(request: RecordedRequest): Promise<FormData> {
  return new Request('http://local', {
    method: 'POST',
    headers: { 'content-type': String(request.headers['content-type']) },
    body: request.body,
  }).formData();
}
