/** An HTTP call to an AI provider failed. `retryable` is false for errors a retry won't fix (bad key, bad request). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface RequestOptions {
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts for network errors, 408, 429 and 5xx. */
  attempts?: number;
  /** Base backoff; doubles each attempt unless the server sends Retry-After. */
  backoffMs?: number;
  /** Builds the body per attempt (a FormData/stream can't be reused). */
  body: () => string | FormData;
  headers?: Record<string, string>;
}

const MAX_BACKOFF_MS = 60_000;

/** POSTs and returns the parsed JSON response, retrying transient failures. */
export async function postJson(url: string, options: RequestOptions): Promise<unknown> {
  const { timeoutMs = 300_000, attempts = 4, backoffMs = 2_000 } = options;
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: options.headers,
        body: options.body(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      lastError = new ProviderError(`Request to ${url} failed: ${reason}`, undefined, true);
      if (attempt < attempts) await sleep(backoff(backoffMs, attempt));
      continue;
    }

    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderError(`${url} returned invalid JSON: ${snippet(text)}`, response.status);
      }
    }

    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    lastError = new ProviderError(`${url} returned ${response.status}: ${snippet(text)}`, response.status, retryable);
    if (!retryable) throw lastError;
    if (attempt < attempts) await sleep(retryAfterMs(response) ?? backoff(backoffMs, attempt));
  }
  throw lastError ?? new ProviderError(`Request to ${url} failed`);
}

export function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Joins a base URL like `https://host/v1` (with or without trailing slash) and a path. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_BACKOFF_MS) : undefined;
}

function backoff(baseMs: number, attempt: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat || '(empty body)';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
