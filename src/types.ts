import type { SomewhereError } from './errors.js';
import type { CacheOptions } from './query-cache.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Client query-cache configuration. `from().select()` is cached by default.
 * - omitted / `true` — on with defaults (~1s staleTime + request dedup).
 * - `false` — off entirely; every read hits the network (pre-v0.5 semantics).
 * - object — on, with the given {@link CacheOptions} (e.g. `{ staleTime }`).
 */
export type CacheConfig = boolean | CacheOptions;

export interface SomewhereOptions {
  /** Developer `smt_` API key. Mutually exclusive with `token`; omit for browser cookie auth. */
  key?: string;
  /** App-user JWT for bearer/compatibility mode. Mutually exclusive with `key`; omit for browser cookie auth. */
  token?: string;
  /** Default `project_id` used by every query/storage/auth/emails/chat call. */
  projectId?: string;
  /** Override the REST base URL. Defaults to `https://api.somewhere.cloud/v1`. */
  baseUrl?: string;
  /**
   * The project's own URL (e.g. `https://my-app.somewhere.site`), used as the
   * host for `functions.invoke(name)` → `{functionsUrl}/api/{name}`. Set
   * automatically when you build the client with `createClient(url, key)`.
   * When omitted, `functions.invoke` returns NO_FUNCTION_HOST without a request;
   * it never derives a host from `projectId`.
   */
  functionsUrl?: string;
  /** Inject a custom fetch implementation (tests, polyfills). */
  fetch?: FetchLike;
  /** Extra headers to attach to every request. */
  headers?: Record<string, string>;
  /**
   * Session transport for `auth.*`.
   *
   * - `'cookie'` (the BROWSER default) — sign-in goes through your app's own
   *   backend auth routes (same origin, `authPath`), which set the session as
   *   httpOnly cookies. No token ever lands in JS or localStorage — XSS can't
   *   steal what the page can't read. Requires the standard backend handler
   *   (`sw.auth.loginWithCookie` et al) mounted at `authPath`.
   * - `'header'` (the default outside browsers, where httpOnly cookies don't
   *   exist) — tokens held in SDK memory, `Authorization: Bearer` transport.
   *   This is also the advanced/manual mode for native apps.
   */
  authMode?: 'cookie' | 'header';
  /** Path your backend auth routes are mounted at (cookie mode). Default '/api/auth'. */
  authPath?: string;
  /**
   * Client query cache for `from().select()`. On by default (~1s staleTime +
   * request dedup + invalidate-on-write). Pass `false` to disable. See
   * {@link CacheConfig}.
   */
  cache?: CacheConfig;
}

/**
 * Options for the `createClient(url, key, options?)` factory.
 */
export interface CreateClientOptions {
  /**
   * Explicit project id, slug, or subdomain. Overrides the value derived
   * from the URL's subdomain. **Required when the URL is a custom domain**
   * (e.g. `https://myapp.com`) — we can't infer the project from it.
   */
  projectId?: string;
  /** Override the platform REST base. Defaults to `https://api.somewhere.cloud/v1`. */
  apiUrl?: string;
  /** Override the functions host. Defaults to the URL passed as the first argument. */
  functionsUrl?: string;
  /** Inject a custom fetch implementation (tests, non-browser runtimes). */
  fetch?: FetchLike;
  /** Extra headers attached to every platform request. */
  headers?: Record<string, string>;
  /** Session transport for `auth.*` — see SomewhereOptions.authMode. Default: 'cookie' in browsers, 'header' elsewhere. */
  authMode?: 'cookie' | 'header';
  /** Path your backend auth routes are mounted at (cookie mode). Default '/api/auth'. */
  authPath?: string;
  /**
   * Client query cache for `from().select()`. On by default. Pass `false` to
   * disable, or an object to tune (e.g. `{ staleTime: 2000 }`). See
   * {@link CacheConfig}.
   */
  cache?: CacheConfig;
}

/** Options for `functions.invoke(name, options)`. */
export interface FunctionInvokeOptions {
  /** Request body. Objects/arrays are JSON-encoded; strings/binary pass through. */
  body?: unknown;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** HTTP method. Defaults to `POST`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

/**
 * Auth state-change events, used by `onAuthStateChange` callbacks.
 */
export type AuthChangeEvent =
  | 'INITIAL_SESSION'
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'TOKEN_REFRESHED'
  | 'USER_UPDATED';

/** Handle returned by `auth.onAuthStateChange` — call `unsubscribe()` to detach. */
export interface AuthSubscription {
  data: { subscription: { unsubscribe: () => void } };
}

/**
 * Every mutating call (db, storage, auth, emails) returns this shape.
 * `error` is null on success, and
 * `data` is null on error. Callers never throw-catch — they branch on
 * the error field.
 *
 * The one exception is `sw.chat.completions.create(...)` which throws,
 * matching the OpenAI SDK.
 */
export interface Result<T> {
  data: T | null;
  error: SomewhereError | null;
  count?: number | null;
  status?: number;
}

/* ─── Auth ─────────────────────────────────────────────────────── */

export interface User {
  id: string;
  email: string;
  display_name?: string | null;
  metadata?: Record<string, unknown> | null;
  email_verified?: boolean;
  created_at: string;
  [k: string]: unknown;
}

export interface Session {
  /**
   * The user's JWT — present in header mode only. A cookie session
   * (`cookie_session: true`) deliberately has NO readable tokens: they live
   * in httpOnly cookies the browser owns, invisible to JS by design.
   */
  access_token?: string;
  /** Long-lived (30d) opaque refresh token. Use `auth.refreshSession()` to mint a new pair. */
  refresh_token?: string;
  /** Server-side session id; pass to `auth.signOut()` to revoke. */
  session_token?: string;
  /** Seconds until `access_token` expires. */
  expires_in?: number;
  /** True when the session is held as httpOnly cookies (browser default). */
  cookie_session?: boolean;
  user: User;
}

export interface AuthResponse {
  user: User | null;
  session: Session | null;
}

/* ─── Email sign-in codes ──────────────────────────────────────── */

/** How a mailed code left the platform: sent, queued, or not confirmed (it may still arrive). */
export type MfaDelivery = 'sent' | 'pending' | 'unknown';

/** A code was mailed to the account's verified address; the next step names `challenge_id`. */
export interface MfaCodeSent {
  challenge_id: string;
  delivery: MfaDelivery;
  /** Seconds the code stays valid (5 minutes). */
  expires_in: number;
}

/** A new code for the pending sign-in. The sign-in keeps its original expiry. */
export interface MfaCodeResent {
  sent: boolean;
  delivery: MfaDelivery;
  expires_in: number;
}

/** Turning codes off: step 1 sends `{ password }` and gets a code; step 2 sends that `challenge_id` and the code. */
export type MfaUnenrollInput = { password: string } | { challenge_id: string; code: string };

/* ─── Storage ──────────────────────────────────────────────────── */

export interface StorageFileObject {
  name: string;
  id?: string;
  bucket?: string;
  /** Bytes. */
  size: number;
  /** RFC-3339 timestamp. */
  updated_at?: string;
  /** Content type as stored on upload. */
  content_type?: string;
}

export interface StorageUploadResult {
  path: string;
  fullPath: string;
  id: string;
}

export interface StorageDownloadResult {
  body: ArrayBuffer;
  contentType: string;
}

export interface SignedUrlResult {
  url: string;
  token: string;
  path: string;
  expires_at: string;
  expires_in: number;
}

export interface IntegrityCheckResult {
  scanned: number;
  orphan_files: Array<{ id: string; path: string; r2_key: string }>;
  orphan_versions: Array<{ id: string; file_id: string; version: number; r2_key: string }>;
  auto_clean: boolean;
  cleaned: { files: number; versions: number };
  next_cursor: string | null;
}

/* ─── Chat completions (OpenAI shape) ─────────────────────────── */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  system?: string;
  /** Provider override — defaults to anthropic on the platform. */
  provider?: string;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/* ─── Email (Resend shape) ────────────────────────────────────── */

export interface SendEmailRequest {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
}

export interface SendEmailResponse {
  id: string;
}

/* ─── Payments (Stripe Connect, zero platform fee) ───────────────── */

export interface PaymentsOnboardRequest {
  /** Defaults to the client's default project. */
  projectId?: string;
  /** Where Stripe sends the user after the hosted onboarding completes. */
  return_url?: string;
  /** Where Stripe sends the user if the link expires before completion. */
  refresh_url?: string;
}

export interface PaymentsOnboardResponse {
  account_id: string;
  onboarding_url: string;
  /** RFC-3339 timestamp. The hosted link expires after a short window. */
  expires_at: string;
}

export interface PaymentsStatusOptions {
  projectId?: string;
  /** When true, re-fetches state from upstream — slower but reconciles after onboarding return. */
  refresh?: boolean;
}

export interface PaymentsStatusResponse {
  connected: boolean;
  account_id?: string;
  onboarded: boolean;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted?: boolean;
  country?: string | null;
  default_currency?: string | null;
}

export interface CheckoutLineItem {
  /** Existing Stripe price id on the connected account. Mutually exclusive with the inline form. */
  price?: string;
  /** Inline amount in the smallest currency unit (cents). Pair with currency + name. */
  amount?: number;
  currency?: string;
  name?: string;
  quantity?: number;
}

export interface PaymentsCheckoutRequest {
  projectId?: string;
  line_items: CheckoutLineItem[];
  mode?: 'payment' | 'subscription';
  success_url: string;
  cancel_url: string;
  customer_email?: string;
  metadata?: Record<string, string>;
}

export interface PaymentsCheckoutResponse {
  session_id: string;
  url: string;
  amount_total_cents: number;
  platform_fee_cents: number;
  fee_percent: number;
}

export interface PaymentsDashboardLinkResponse {
  url: string;
}

/* ─── Video (Cloudflare Stream wrapper) ──────────────────────────── */

export interface VideoUploadUrlRequest {
  projectId?: string;
  title?: string;
  /** Caps the longest video the upload URL will accept. Clamped 30–21600s. */
  max_duration_seconds?: number;
  require_signed_urls?: boolean;
}

export interface VideoUploadUrlResponse {
  video_id: string;
  upload_url: string;
  max_duration_seconds: number;
}

export interface VideoObject {
  id: string;
  project_id: string;
  title: string | null;
  ready: boolean;
  status: string;
  size_bytes: number;
  duration_seconds: number;
  thumbnail: string;
  preview: string;
  hls_url: string;
  dash_url: string;
  /** RFC-3339 timestamp. */
  created_at: string;
  /** RFC-3339 timestamp. */
  modified_at: string;
}

export interface VideoListResponse {
  videos: VideoObject[];
  count: number;
}

/* ─── Inbox (inbound email) ──────────────────────────────────────── */

export interface InboxAddressCreateRequest {
  projectId?: string;
  /** Local-part only. The platform adds the inbox.{platform-domain} suffix. */
  local: string;
  label?: string;
}

export interface InboxAddress {
  id: string;
  project_id: string;
  address: string;
  label: string | null;
  /** RFC-3339 timestamp. */
  created_at: string;
}

export interface InboxAddressListResponse {
  addresses: InboxAddress[];
}

export interface InboxMessageSummary {
  id: string;
  address_id: string;
  project_id: string;
  mail_from: string;
  mail_to: string;
  subject: string | null;
  text_preview: string | null;
  size_bytes: number;
  /** RFC-3339 timestamp. */
  received_at: string;
}

export interface InboxMessageListResponse {
  messages: InboxMessageSummary[];
  count: number;
}

export interface InboxMessageDetail extends InboxMessageSummary {
  r2_key: string;
  /** Sub-path on the API base URL that returns the raw .eml bytes. */
  raw_url: string;
}

export interface InboxListOptions {
  projectId?: string;
  addressId?: string;
  limit?: number;
}

/* ─── Calls (WebRTC SFU passthrough) ─────────────────────────────── */

export interface CallsSessionCreateRequest {
  projectId?: string;
  thirdparty?: boolean;
}

export interface CallsSessionCreateResponse {
  session_id: string;
  project_id: string;
}
