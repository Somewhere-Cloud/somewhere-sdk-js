import { SomewhereError } from './errors.js';
const DEFAULT_BASE_URL = 'https://api.somewhere.tech/v1';
function isBinaryBody(body) {
    if (typeof FormData !== 'undefined' && body instanceof FormData)
        return true;
    if (typeof Blob !== 'undefined' && body instanceof Blob)
        return true;
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)
        return true;
    if (ArrayBuffer.isView(body))
        return true;
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream)
        return true;
    return false;
}
export class Client {
    constructor(opts) {
        if (!opts.key && !opts.token) {
            throw new Error('Somewhere: pass either `key` (smt_...) or `token` (app-user JWT).');
        }
        if (opts.key && opts.token) {
            throw new Error('Somewhere: pass `key` OR `token`, not both.');
        }
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
        this.defaultProjectId = opts.projectId;
        this.authHeader = `Bearer ${opts.key ?? opts.token}`;
        this.extraHeaders = opts.headers ?? {};
        const f = opts.fetch ?? globalThis.fetch?.bind(globalThis);
        if (!f) {
            throw new Error('Somewhere: no fetch implementation found. Pass `fetch` explicitly.');
        }
        this.fetchImpl = f;
    }
    resolveProjectId(explicit) {
        return explicit ?? this.defaultProjectId;
    }
    /** JSON request → JSON response. Unwraps `{ok, data}` → `data`, throws on error. */
    async call(method, path, opts = {}) {
        const url = this.buildUrl(path, opts.query);
        const headers = {
            Authorization: this.authHeader,
            Accept: 'application/json',
            ...this.extraHeaders,
        };
        let body;
        if (opts.body !== undefined) {
            if (isBinaryBody(opts.body)) {
                // Let the runtime set Content-Type (multipart boundary, etc.).
                body = opts.body;
            }
            else {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(opts.body);
            }
        }
        const res = await this.fetchImpl(url, { method, headers, body });
        const parsed = await this.parseJson(res);
        return this.unwrap(parsed, res.status);
    }
    /** Raw binary download — used by storage.get / fs.read for file bodies. */
    async getBytes(path, query) {
        const url = this.buildUrl(path, query);
        const res = await this.fetchImpl(url, {
            method: 'GET',
            headers: { Authorization: this.authHeader, ...this.extraHeaders },
        });
        if (!res.ok) {
            const parsed = await this.parseJson(res).catch(() => null);
            throw this.toError(parsed, res.status);
        }
        return {
            body: await res.arrayBuffer(),
            contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        };
    }
    /** Raw binary upload — used by storage.put / fs.write. */
    async putBytes(path, body, contentType) {
        const url = this.buildUrl(path);
        const res = await this.fetchImpl(url, {
            method: 'PUT',
            headers: {
                Authorization: this.authHeader,
                'Content-Type': contentType,
                Accept: 'application/json',
                ...this.extraHeaders,
            },
            body,
        });
        const parsed = await this.parseJson(res);
        return this.unwrap(parsed, res.status);
    }
    buildUrl(path, query) {
        const suffix = path.startsWith('/') ? path : `/${path}`;
        const base = `${this.baseUrl}${suffix}`;
        if (!query)
            return base;
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null)
                continue;
            params.append(k, String(v));
        }
        const qs = params.toString();
        return qs ? `${base}?${qs}` : base;
    }
    async parseJson(res) {
        const text = await res.text();
        if (!text)
            return null;
        try {
            return JSON.parse(text);
        }
        catch {
            throw new SomewhereError({
                code: 'INVALID_RESPONSE',
                message: `Non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
                statusCode: res.status,
                retry: res.status >= 500,
                retryAfterMs: null,
            });
        }
    }
    unwrap(parsed, statusCode) {
        if (parsed && parsed.ok === true) {
            return parsed.data;
        }
        throw this.toError(parsed, statusCode);
    }
    toError(parsed, statusCode) {
        if (parsed && parsed.ok === false) {
            const retryAfterMs = typeof parsed.retry_after_ms === 'number' ? parsed.retry_after_ms : null;
            return new SomewhereError({
                code: parsed.error ?? 'UNKNOWN_ERROR',
                message: parsed.message ?? 'Unknown error',
                statusCode,
                retry: parsed.retry === true,
                retryAfterMs,
                body: parsed,
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
