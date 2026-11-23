import type { Client } from '../client.js';
import { SomewhereError } from '../errors.js';
import type {
  IntegrityCheckResult,
  Result,
  SignedUrlResult,
  StorageDownloadResult,
  StorageFileObject,
  StorageUploadResult,
} from '../types.js';

/**
 * Prefix-oriented file API.
 *
 * Routes through `/v1/fs/*` (the platform's structured filesystem).
 * "Buckets" are prefix directories under the project's file namespace:
 * `sw.storage.from('avatars').upload('a.png', ...)` writes to
 * `/v1/fs/{project_id}/avatars/a.png`.
 *
 * For browser uploads with per-user or per-team rules, declare a file
 * collection in db/schema.ts and use the generated `somewhere:files` client
 * instead: docs({ topic: 'declared-files' }).
 */
export class StorageClient {
  constructor(private readonly client: Client) {}

  from(bucket: string): StorageFileApi {
    return new StorageFileApi(this.client, bucket);
  }
}

export interface UploadOptions {
  contentType?: string;
  upsert?: boolean;
}

export class StorageFileApi {
  constructor(
    private readonly client: Client,
    private readonly bucket: string,
  ) {}

  async upload(
    path: string,
    fileBody: BodyInit,
    options: UploadOptions = {},
  ): Promise<Result<StorageUploadResult>> {
    const projectId = this.requireProjectId('upload');
    const fullPath = this.fullKey(path);
    try {
      const result = await this.client.putBytes<{
        path?: string;
        size_bytes?: number;
        content_type?: string;
      }>(
        `/fs/${enc(projectId)}/${encKey(fullPath)}`,
        fileBody,
        options.contentType ?? inferContentType(fileBody) ?? 'application/octet-stream',
      );
      return {
        data: {
          path,
          fullPath: result.path ?? fullPath,
          id: result.path ?? fullPath,
        },
        error: null,
        status: 200,
      };
    } catch (err) {
      return toResultError(err);
    }
  }

  async download(path: string): Promise<Result<StorageDownloadResult>> {
    const projectId = this.requireProjectId('download');
    const fullPath = this.fullKey(path);
    try {
      const result = await this.client.getBytes(
        `/fs/${enc(projectId)}/${encKey(fullPath)}`,
      );
      return { data: result, error: null, status: 200 };
    } catch (err) {
      return toResultError(err);
    }
  }

  /**
   * List files in this bucket (or a sub-prefix).
   * Routes to `GET /v1/fs/{pid}/{bucket}/{prefix}` which returns
   * a directory listing when the path is a directory.
   */
  async list(
    prefix = '',
    _options: { limit?: number; cursor?: string } = {},
  ): Promise<Result<StorageFileObject[]>> {
    const projectId = this.requireProjectId('list');
    const dirPath = prefix ? this.fullKey(prefix) : this.bucket;
    try {
      const result = await this.client.getBytes(
        `/fs/${enc(projectId)}/${encKey(dirPath)}`,
      );
      if (result.contentType.includes('application/json')) {
        const text = new TextDecoder().decode(result.body);
        const parsed = JSON.parse(text);
        const data = parsed?.ok ? parsed.data : parsed;
        if (data?.type === 'directory' && Array.isArray(data.entries)) {
          const objects: StorageFileObject[] = data.entries.map(
            (e: {
              name: string;
              path?: string;
              size_bytes?: number;
              content_type?: string;
              updated_at?: string;
            }) => ({
              name: e.name,
              size: e.size_bytes ?? 0,
              content_type: e.content_type,
              updated_at: e.updated_at,
            }),
          );
          return { data: objects, error: null, status: 200 };
        }
      }
      return { data: [], error: null, status: 200 };
    } catch (err) {
      return toResultError<StorageFileObject[]>(err);
    }
  }

  async remove(paths: string[]): Promise<Result<StorageFileObject[]>> {
    const projectId = this.requireProjectId('remove');
    const removed: StorageFileObject[] = [];
    for (const p of paths) {
      const fullPath = this.fullKey(p);
      try {
        await this.client.call(
          'DELETE',
          `/fs/${enc(projectId)}/${encKey(fullPath)}`,
        );
        removed.push({ name: p, size: 0 });
      } catch (err) {
        return toResultError<StorageFileObject[]>(err);
      }
    }
    return { data: removed, error: null, status: 200 };
  }

  getPublicUrl(path: string): { data: { publicUrl: string } } {
    const projectId = this.requireProjectId('getPublicUrl');
    const fullPath = this.fullKey(path);
    const publicUrl = `${this.client.baseUrl}/fs/${enc(projectId)}/${encKey(fullPath)}`;
    return { data: { publicUrl } };
  }

  async signedUrl(
    path: string,
    options: { expiresIn?: number } = {},
  ): Promise<Result<SignedUrlResult>> {
    const projectId = this.requireProjectId('signedUrl');
    const fullPath = this.fullKey(path);
    try {
      const body: Record<string, unknown> = { path: '/' + fullPath };
      if (typeof options.expiresIn === 'number') body.expires_in = options.expiresIn;
      const res = await this.client.call('POST', `/fs/${enc(projectId)}/sign`, { body });
      return { data: res as SignedUrlResult, error: null, status: 200 };
    } catch (err) {
      return toResultError(err);
    }
  }

  /**
   * Alias of `signedUrl`. `createSignedUrl(path, expiresIn)` resolves to
   * `{ data: { signedUrl, ...meta }, error }`.
   */
  async createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<Result<SignedUrlResult & { signedUrl: string }>> {
    const res = await this.signedUrl(path, { expiresIn });
    if (res.error || !res.data) {
      return { data: null, error: res.error, status: res.status };
    }
    return {
      data: { ...res.data, signedUrl: res.data.url },
      error: null,
      status: res.status,
    };
  }

  async integrityCheck(
    options: { autoClean?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<Result<IntegrityCheckResult>> {
    const projectId = this.requireProjectId('integrityCheck');
    try {
      const body: Record<string, unknown> = {};
      if (options.autoClean === true) body.auto_clean = true;
      if (typeof options.limit === 'number') body.limit = options.limit;
      if (typeof options.cursor === 'string') body.cursor = options.cursor;
      const res = await this.client.call('POST', `/fs/${enc(projectId)}/integrity-check`, body);
      return { data: res as IntegrityCheckResult, error: null, status: 200 };
    } catch (err) {
      return toResultError(err);
    }
  }

  private fullKey(path: string): string {
    const trimmed = path.startsWith('/') ? path.slice(1) : path;
    return `${this.bucket}/${trimmed}`;
  }

  private requireProjectId(method: string): string {
    return this.client.requireProjectId(
      undefined,
      `storage.from('${this.bucket}').${method}`,
    );
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function encKey(key: string): string {
  return key
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function inferContentType(body: BodyInit): string | null {
  if (typeof Blob !== 'undefined' && body instanceof Blob && body.type) {
    return body.type;
  }
  if (typeof body === 'string') {
    return 'text/plain; charset=utf-8';
  }
  return null;
}

function toResultError<T>(err: unknown): Result<T> {
  if (err instanceof SomewhereError) {
    return { data: null, error: err, status: err.statusCode };
  }
  throw err;
}
