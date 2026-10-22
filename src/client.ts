import { SomewhereError } from './errors.js';
import { QueryCache } from './query-cache.js';
import type { FetchLike, Result, SomewhereOptions } from './types.js';

const DEFAULT_BASE_URL = 'https://api.somewhere.tech/v1';

/**
 * Which auth header a request should use.
 *
 * - `developer` — always the initial `smt_` key given at construction.
 *   Developer-only endpoints (`/ai/*`, `/email/*`, `/auth/signup`,
 *   `/auth/login`, `/auth/logout`, `/auth/forgot`, `/auth/reset`) use
 *   this mode even if a user session is active — the server rejects
 *   JWTs on those routes.
 *
 * - `dual` — use the user's session JWT if one is active (after
 *   `auth.signInWithPassword`), otherwise fall back to the initial
 *   key. This matches the server's dual-auth routes: `/db/query`,
 *   `/storage/*`, `/fs/*`, `/auth/me`, `/logs`.
 *
 * - `session` — require an active user session. Used for routes the
 *   server only accepts with an app-user JWT (`/auth/users/me`).
 */
export type AuthMode = 'developer' | 'dual' | 'session';

function isBinaryBody(body: unknown): boolean {
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body as ArrayBufferView)) return true;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return true;
  return false;
}

/**
 * Internal HTTP client. Not exported from the SDK surface — the
 * `Somewhere` facade owns a single Client instance and passes it to
 * every resource. Handles auth mode resolution, envelope unwrapping,
 * typed error materialization, binary round-trips, and the `safeCall`
 * helper that converts `call` into a `Result<T>` envelope for the
 * result-envelope surfaces.
 */
export class Client {
  readonly baseUrl: string;
  /** The project's own URL (functions host), if known. See SomewhereOptions.functionsUrl. */
  readonly functionsUrl?: string;
  /**
   * Session transport for `auth.*` (tsk_0de555b1). 'cookie' = httpOnly cookie
   * sessions via the app's own backend routes — the browser default, because
   * localStorage tokens are XSS-exfiltratable and httpOnly cookies aren't.
   * 'header' = Bearer tokens in SDK memory — the default outside browsers
   * (Node/CLI/native have no httpOnly cookie jar) and the manual/advanced mode.
   */
  readonly authMode: 'cookie' | 'header';
  /** Path the app's backend auth routes are mounted at (cookie mode). */
  readonly authPath: string;
  defaultProjectId?: string;
  private readonly initialAuthHeader: string | null;
  /** Credential supplied at construction, or none for the browser cookie path. */
  private readonly initialAuthKind: 'key' | 'token' | 'none';
  /**
   * Set by `auth.signInWithPassword` / `auth.signUp` on success.
   * Cleared by `auth.signOut`. Used by `dual` and `session` auth modes;
   * NEVER overrides `developer` mode (developer-only endpoints always
   * use the initial `smt_` key — the server rejects JWTs on them).
   */
  private sessionAuthHeader: string | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Record<string, string>;
  /** Surfaces already warned about. Direct browser database and file API calls are disabled;
   * each surface warns once. */
  private readonly browserDataWarnings = new Set<'database' | 'files'>();
  /**
   * Instance-scoped query cache for `from().select()`, or `null` when the
   * caller passed `{ cache: false }`. Consulted by the PostgrestFilterBuilder
   * executor. Explicit session transitions clear cached and pending reads.
   */
  readonly cache: QueryCache | null;

  constructor(opts: SomewhereOptions) {
    if (opts.key && opts.token) {
      throw new Error('Somewhere: pass `key` OR `token`, not both.');
    }
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.authMode =
      opts.authMode ?? (typeof document !== 'undefined' ? 'cookie' : 'header');
    if (!opts.key && !opts.token && this.authMode !== 'cookie') {
      throw new Error(
        'Somewhere: bearer mode requires either `key` (smt_...) or `token` (app-user JWT).',
      );
    }
    this.authPath = (opts.authPath ?? '/api/auth').replace(/\/$/, '');
    this.functionsUrl = opts.functionsUrl
      ? opts.functionsUrl.replace(/\/$/, '').replace(/\/v1$/, '')
      : undefined;
    this.defaultProjectId = opts.projectId;
    const initialCredential = opts.key ?? opts.token;
    this.initialAuthHeader = initialCredential ? `Bearer ${initialCredential}` : null;
    this.initialAuthKind = opts.key ? 'key' : opts.token ? 'token' : 'none';
    this.extraHeaders = opts.headers ?? {};
    const f = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (!f) {
      throw new Error('Somewhere: no fetch implementation found. Pass `fetch` explicitly.');
    }
    this.fetchImpl = f;
    const cacheOpt = opts.cache;
    this.cache =
      cacheOpt === false
        ? null
        : new QueryCache(cacheOpt === true || cacheOpt === undefined ? {} : cacheOpt);
  }

  /**
   * Drop cached `from().select()` reads for a table. Invoked automatically
   * after a write to the table (read-your-own-writes); also the public seam
   * for event-driven invalidation. No-op when the cache is disabled.
   */
  invalidateTable(table: string): void {
    this.cache?.invalidate(table);
  }

  /** True when the client was constructed with a developer `smt_` key. */
  get hasDeveloperKey(): boolean {
    return this.initialAuthKind === 'key';
  }

  /** True when a user session is currently active. */
  get hasSession(): boolean {
    return this.sessionAuthHeader !== null;
  }

  resolveProjectId(explicit?: string): string | undefined {
    return explicit ?? this.defaultProjectId;
  }

  requireProjectId(explicit?: string, what = 'this call'): string {
    const pid = this.resolveProjectId(explicit);
    if (!pid) {
      throw new Error(
        `Somewhere: ${what} requires a projectId (pass one in the constructor).`,
      );
    }
    return pid;
  }

  setSessionToken(accessToken: string): void {
    const header = `Bearer ${accessToken}`;
    if (header !== this.sessionAuthHeader) this.cache?.clear();
    this.sessionAuthHeader = header;
  }

  clearSession(): void {
    this.cache?.clear();
    this.sessionAuthHeader = null;
  }

  /**
   * The `Authorization` value a project-function call should carry: the
   * active user session if signed in, else the construction key/token.
   * Same precedence as `dual` mode.
   */
  get sessionOrInitialBearer(): string {
    const header = this.sessionAuthHeader ?? this.initialAuthHeader;
    if (!header) {
      throw new SomewhereError({
        code: 'BROWSER_SERVER_FUNCTION_REQUIRED',
        message:
          'This browser cookie client has no bearer credential. Call a same-origin server function ' +
          'with `functions.invoke`; use sw.auth.fromRequest and sw.* inside that function.',
        statusCode: 400,
        retry: false,
        retryAfterMs: null,
      });
    }
    return header;
  }

  /** Low-level fetch passthrough for absolute URLs (project function hosts). */
  rawFetch(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(url, init);
  }

  private authHeader(mode: AuthMode = 'dual'): string {
    if (mode === 'developer') {
      if (this.initialAuthKind !== 'key') {
        throw new SomewhereError({
          code: 'INVALID_API_KEY',
          message:
            'This call requires a developer `smt_` API key. ' +
            'Create the client with `{ key: "smt_..." }` (server-side only).',
          statusCode: 401,
          retry: false,
          retryAfterMs: null,
        });
      }
      return this.initialAuthHeader!;
    }
    if (mode === 'session') {
      if (!this.sessionAuthHeader) {
        throw new SomewhereError({
          code: 'AUTH_INVALID_CREDS',
          message:
            'This call requires an active user session. Sign in with ' +
            '`sw.auth.signInWithPassword({ email, password })` first.',
          statusCode: 401,
          retry: false,
          retryAfterMs: null,
        });
      }
      return this.sessionAuthHeader;
    }
    // dual
    const header = this.sessionAuthHeader ?? this.initialAuthHeader;
    if (!header) {
      throw new SomewhereError({
        code: 'BROWSER_SERVER_FUNCTION_REQUIRED',
        message:
          'This browser cookie client has no bearer credential. Move the operation into a ' +
          'same-origin server function and call it with `functions.invoke`.',
        statusCode: 400,
        retry: false,
        retryAfterMs: null,
      });
    }
    return header;
  }

  /** JSON request → JSON response. Unwraps `{ok, data}` → `data`, throws on error. */
  async call<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, unknown>;
      auth?: AuthMode;
      signal?: AbortSignal;
      /** Session credential for this request only; never installs client state. */
      sessionBearer?: string;
    } = {},
  ): Promise<T> {
    if (opts.sessionBearer !== undefined && opts.auth !== 'session') {
      throw new Error('A per-request session bearer requires session auth.');
    }
    this.warnOnDirectBrowserDataAccess(path);
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: opts.sessionBearer === undefined ? this.authHeader(opts.auth ?? 'dual') : `Bearer ${opts.sessionBearer}`,
      Accept: 'application/json',
      ...this.extraHeaders,
    };
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      if (isBinaryBody(opts.body)) {
        body = opts.body as BodyInit;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      throw new SomewhereError({
        code: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Network error reaching the platform.',
        statusCode: 0,
        retry: true,
        retryAfterMs: null,
      });
    }
    const parsed = await this.parseJson(res);
    return this.unwrap<T>(parsed, res.status);
  }

  /**
   * Same as `call` but never throws — always returns a `Result<T>`.
   * Used by result-envelope surfaces where the caller branches
   * on `.error` instead of catching.
   */
  async safeCall<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, unknown>;
      auth?: AuthMode;
    } = {},
  ): Promise<Result<T>> {
    try {
      const data = await this.call<T>(method, path, opts);
      return { data, error: null, status: 200 };
    } catch (err) {
      if (err instanceof SomewhereError) {
        return { data: null, error: err, status: err.statusCode };
      }
      throw err;
    }
  }

  /** Raw binary download. */
  async getBytes(
    path: string,
    query?: Record<string, unknown>,
    auth: AuthMode = 'dual',
  ): Promise<{ body: ArrayBuffer; contentType: string }> {
    this.warnOnDirectBrowserDataAccess(path);
    const url = this.buildUrl(path, query);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: this.authHeader(auth), ...this.extraHeaders },
      });
    } catch (err) {
      throw new SomewhereError({
        code: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Network error reaching the platform.',
        statusCode: 0,
        retry: true,
        retryAfterMs: null,
      });
    }
    if (!res.ok) {
      const parsed = await this.parseJson(res).catch(() => null);
      throw this.toError(parsed, res.status);
    }
    return {
      body: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /** Raw binary upload. */
  async putBytes<T = unknown>(
    path: string,
    body: BodyInit,
    contentType: string,
    auth: AuthMode = 'dual',
  ): Promise<T> {
    this.warnOnDirectBrowserDataAccess(path);
    const url = this.buildUrl(path);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: {
          Authorization: this.authHeader(auth),
          'Content-Type': contentType,
          Accept: 'application/json',
          ...this.extraHeaders,
        },
        body,
      });
    } catch (err) {
      throw new SomewhereError({
        code: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Network error reaching the platform.',
        statusCode: 0,
        retry: true,
        retryAfterMs: null,
      });
    }
    const parsed = await this.parseJson(res);
    return this.unwrap<T>(parsed, res.status);
  }

  /**
   * Direct browser calls to the platform's database and file APIs are
   * disabled; browser code uses declared data/file collections or a server
   * function. This one-time warning says so. It does not block or alter the
   * request: the server decides, and the caller gets that answer as a normal
   * Result. Server-side use of these APIs is unaffected.
   */
  private warnOnDirectBrowserDataAccess(path: string): void {
    if (typeof document === 'undefined') return;
    const surface =
      path === '/db' || path.startsWith('/db/')
        ? 'database'
        : path === '/fs' || path.startsWith('/fs/') || path === '/storage' || path.startsWith('/storage/')
          ? 'files'
          : null;
    if (!surface || this.browserDataWarnings.has(surface)) return;
    this.browserDataWarnings.add(surface);
    globalThis.console?.warn?.(
      surface === 'database'
        ? '[@somewhere-tech/sdk] Direct browser database API calls are disabled. ' +
            'Use the generated somewhere:data client for operations allowed by your declared data rules, ' +
            'or call a server function that uses sw.db.'
        : '[@somewhere-tech/sdk] Direct browser file API calls are disabled. ' +
            'Use a declared somewhere:files collection, or call a server function that uses sw.fs.',
    );
  }

  private buildUrl(path: string, query?: Record<string, unknown>): string {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const base = `${this.baseUrl}${suffix}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async parseJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON body (typically an HTML error page from a 5xx upstream
      // or a CF-level block). Turn it into a typed error rather than
      // letting the raw JSON.parse fault bubble up.
      if (res.ok) {
        return null;
      }
      throw new SomewhereError({
        code: 'INVALID_RESPONSE',
        message: `Non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
        statusCode: res.status,
        retry: res.status >= 500,
        retryAfterMs: null,
      });
    }
  }

  private unwrap<T>(parsed: unknown, statusCode: number): T {
    // Empty-body success (204 No Content, or a proxy returning an empty
    // body with a 200). Treat as `{data: null}` instead of throwing.
    if (parsed === null && statusCode >= 200 && statusCode < 300) {
      return null as T;
    }
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
      const envelope = parsed as { ok: boolean; data?: T };
      if (envelope.ok === true) {
        return envelope.data as T;
      }
    }
    throw this.toError(parsed, statusCode);
  }

  private toError(parsed: unknown, statusCode: number): SomewhereError {
    if (
      parsed &&
      typeof parsed === 'object' &&
      'ok' in parsed &&
      (parsed as { ok: unknown }).ok === false
    ) {
      const body = parsed as {
        ok: false;
        error?: string;
        message?: string;
        retry?: boolean;
        retry_after_ms?: number | null;
      };
      const retryAfterMs = typeof body.retry_after_ms === 'number' ? body.retry_after_ms : null;
      return new SomewhereError({
        code: body.error ?? 'UNKNOWN_ERROR',
        message: body.message ?? 'Unknown error',
        statusCode,
        retry: body.retry === true,
        retryAfterMs,
        body,
      });
    }
    return new SomewhereError({
      code: 'INVALID_RESPONSE',
      message: `Unexpected response shape (status ${statusCode})`,
      statusCode,
      retry: statusCode >= 500,
      retryAfterMs: null,
      body: parsed,
    });
  }
}
