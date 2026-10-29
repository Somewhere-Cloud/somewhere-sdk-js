import type { Client } from '../client.js';
import { SomewhereError } from '../errors.js';
import type { FunctionInvokeOptions, Result } from '../types.js';

/**
 * Application-function invocation client.
 *
 *     const { data, error } = await sw.functions.invoke('checkout', {
 *       body: { plan: 'pro' },
 *     })
 *
 * `invoke(name)` calls `POST {projectUrl}/api/{name}` — the project's own
 * deployed function (an `api/{name}` file). `data` is the function's parsed
 * JSON response (or text); `error` is set on any non-2xx status or network
 * failure, using the established `{ data, error }` envelope.
 *
 * The function host is the app URL you passed to `createClient(appUrl, key)`
 * or as `functionsUrl`. It is never derived from `projectId`: a project id
 * can be a slug that is unique only to its owner, and the same text can be
 * another customer's subdomain, so a derived host could receive your
 * credentials. Without an app URL `invoke` returns `NO_FUNCTION_HOST` before
 * any request. In a project folder the CLI records the platform-reported URL
 * as `app_url` in `.somewhere.json`, and `somewhere status --json` prints it.
 */

export class FunctionsClient {
  constructor(private readonly client: Client) {}

  async invoke<T = unknown>(
    name: string,
    options: FunctionInvokeOptions = {},
  ): Promise<Result<T>> {
    const base = this.resolveBase();
    if (!base) {
      return errored(
        'NO_FUNCTION_HOST',
        "functions.invoke needs your app's URL, and a project id is not one. " +
          'Build the client with createClient(appUrl, key) or pass { functionsUrl }. ' +
          'In a project folder, app_url in .somewhere.json (or `somewhere status --json`) is the platform-reported URL.',
        400,
      );
    }

    const fn = name.replace(/^\/+/, '').replace(/^api\//, '');
    if (!fn) {
      return errored('VALIDATION_ERROR', 'functions.invoke requires a function name.', 400);
    }
    const url = `${base}/api/${fn}`;
    const method = options.method ?? 'POST';

    // Cookie-mode sessions (browser default): the httpOnly cookie carries
    // the user's identity, so send credentials and OMIT Authorization —
    // sw.auth.fromRequest prefers a Bearer header, and the static
    // construction key would shadow the signed-in cookie user. An active
    // header session (or explicit header mode) keeps the 0.5.x transport.
    const cookieMode = this.client.authMode === 'cookie' && !this.client.hasSession;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(cookieMode ? {} : { Authorization: this.client.sessionOrInitialBearer }),
      ...(options.headers ?? {}),
    };

    let body: BodyInit | undefined;
    if (options.body !== undefined && method !== 'GET') {
      if (isBinary(options.body)) {
        body = options.body as BodyInit;
      } else if (typeof options.body === 'string') {
        body = options.body;
        headers['Content-Type'] ??= 'text/plain;charset=UTF-8';
      } else {
        body = JSON.stringify(options.body);
        headers['Content-Type'] ??= 'application/json';
      }
    }

    let res: Response;
    try {
      res = await this.client.rawFetch(url, {
        method,
        headers,
        body,
        ...(cookieMode ? { credentials: 'include' as RequestCredentials } : {}),
      });
    } catch (err) {
      return errored(
        'NETWORK_ERROR',
        err instanceof Error ? err.message : `Network error reaching ${url}.`,
        0,
        true,
      );
    }

    const parsed = await readBody(res);
    if (!res.ok) {
      const b = parsed as {
        error?: string;
        message?: string;
        retry?: unknown;
        retryable?: unknown;
        outcome?: unknown;
        write_committed?: unknown;
        prior_write_committed?: unknown;
        retry_after_ms?: unknown;
      } | null;
      // An unknown or committed write must not be repeated just because the
      // response is 5xx. Keep explicit refusals ahead of any retry:true hint.
      const unsafeToRetry = b?.retry === false || b?.retryable === false
        || b?.outcome === 'unknown' || b?.outcome === 'committed'
        || b?.write_committed === true || b?.prior_write_committed === true;
      const retry = unsafeToRetry ? false
        : typeof b?.retry === 'boolean' ? b.retry : res.status >= 500;
      const retryAfterMs = b?.retry_after_ms;
      return {
        data: null,
        error: new SomewhereError({
          code: b?.error ?? `FUNCTION_HTTP_${res.status}`,
          message: b?.message ?? `Function '${fn}' returned ${res.status}.`,
          statusCode: res.status,
          retry,
          retryAfterMs: typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
            ? retryAfterMs : null,
          body: parsed,
        }),
        status: res.status,
      };
    }
    return { data: parsed as T, error: null, status: res.status };
  }

  /** The caller-supplied app URL, or null. Never derived from projectId. */
  private resolveBase(): string | null {
    return this.client.functionsUrl ?? null;
  }
}

function errored<T>(
  code: string,
  message: string,
  statusCode: number,
  retry = false,
): Result<T> {
  return {
    data: null,
    error: new SomewhereError({ code, message, statusCode, retry, retryAfterMs: null }),
    status: statusCode,
  };
}

function isBinary(body: unknown): boolean {
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body as ArrayBufferView)) return true;
  return false;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
