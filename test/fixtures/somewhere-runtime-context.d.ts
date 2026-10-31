
type __SomewhereJsonPrimitive = string | number | boolean | null;
type __SomewhereJson = __SomewhereJsonPrimitive | { [key: string]: __SomewhereJson } | __SomewhereJson[];
type SomewhereDbScalar = string | number | boolean | null;
type __SomewhereDbOperators = {
  eq: SomewhereDbScalar; ne: SomewhereDbScalar;
  lt: SomewhereDbScalar; lte: SomewhereDbScalar;
  gt: SomewhereDbScalar; gte: SomewhereDbScalar;
  like: SomewhereDbScalar; in: readonly SomewhereDbScalar[];
  not: null; contains: string; startsWith: string; endsWith: string;
};
type __SomewhereDbOperator = {
  [K in keyof __SomewhereDbOperators]: Pick<__SomewhereDbOperators, K>
    & Partial<Record<Exclude<keyof __SomewhereDbOperators, K>, never>>
}[keyof __SomewhereDbOperators];
type SomewhereDbCondition = SomewhereDbScalar | __SomewhereDbOperator;
type SomewhereDbOrBranch = Readonly<Record<string, SomewhereDbCondition>>;
type SomewhereDbWhere = Readonly<{
  $or?: readonly SomewhereDbOrBranch[];
} & Record<string, SomewhereDbCondition | readonly SomewhereDbCondition[] | readonly SomewhereDbOrBranch[] | undefined>>;
type SomewhereDbOrder = string | readonly [string, ('asc' | 'desc')?]
  | readonly (readonly [string, ('asc' | 'desc')?])[];
interface SomewhereDbReadOptions {
  where?: SomewhereDbWhere | null;
  order?: SomewhereDbOrder | null;
  limit?: number | null;
  offset?: number | null;
  columns?: readonly string[] | null;
  include?: readonly string[] | null;
  has?: Readonly<Record<string, SomewhereDbWhere>> | null;
}
interface SomewhereDbCountOptions { where?: SomewhereDbWhere | null }
interface SomewhereDbInsertOptions { onConflict?: 'ignore' | 'update' | null }
type SomewhereDbValues = Readonly<Record<string, __SomewhereJson>>;
type SomewhereDbIncrement = Readonly<Record<string, number>>;
type SomewhereDbUpdate = {
  where?: SomewhereDbWhere | null;
} & (
  | { set: SomewhereDbValues; increment?: SomewhereDbIncrement | null }
  | { set?: never; increment: SomewhereDbIncrement }
);
interface SomewhereDbRemove { where?: SomewhereDbWhere | null }
type SomewhereDbWriteIntent =
  | { op: 'insert'; table: string; values: SomewhereDbValues; options?: SomewhereDbInsertOptions | null }
  | ({ op: 'update'; table: string } & SomewhereDbUpdate)
  | { op: 'remove'; table: string; where?: SomewhereDbWhere | null };
// db/schema.ts's tables, one entry each, generated beside this declaration
// (declaredTablesDeclaration). With no declared tables it stays empty: any
// table name is accepted and rows are Record<string, unknown>. Once tables are
// declared, structured calls accept only their names and rows carry the
// declared types. Raw SQL rows are never typed from it.
interface SomewhereDeclaredTables {}
type SomewhereDbTable = [keyof SomewhereDeclaredTables] extends [never] ? string : Extract<keyof SomewhereDeclaredTables, string>;
type __SomewhereDeclared<T extends string, K extends string, Fallback> = T extends keyof SomewhereDeclaredTables
  ? K extends keyof SomewhereDeclaredTables[T] ? SomewhereDeclaredTables[T][K] : Fallback
  : Fallback;
type SomewhereDbRow<T extends string> = __SomewhereDeclared<T, 'row', Record<string, unknown>>;
type SomewhereDbColumn<T extends string> = Extract<keyof SomewhereDbRow<T>, string>;
type SomewhereDbRelations<T extends string> = __SomewhereDeclared<T, 'relations', Record<string, unknown>>;
type SomewhereDbRelationName<T extends string> = Extract<keyof SomewhereDbRelations<T>, string>;
// A column list narrows the rows to those columns; each included relation adds
// its related rows under its name.
type SomewhereDbReadRow<T extends string, C, I> = T extends keyof SomewhereDeclaredTables
  ? Pick<SomewhereDbRow<T>, Extract<C extends readonly (infer K)[] ? K : never, keyof SomewhereDbRow<T>>>
    & Pick<SomewhereDbRelations<T>, Extract<I extends readonly (infer K)[] ? K : never, keyof SomewhereDbRelations<T>>>
  : Record<string, unknown>;
type SomewhereDbReadOptionsFor<T extends string, C, I> = Omit<SomewhereDbReadOptions, 'columns' | 'include'> & {
  columns?: C | null;
  include?: I | null;
};
type SomewhereDbIncrementFor<T extends string> = T extends keyof SomewhereDeclaredTables
  ? { readonly [K in __SomewhereDeclared<T, 'numeric', never>]?: number }
  : SomewhereDbIncrement;
// A caller write never names row identity; server authority may ('serverSet').
type SomewhereDbUpdateFor<T extends string, Set extends 'set' | 'serverSet'> = {
  where?: SomewhereDbWhere | null;
} & (
  | { set: __SomewhereDeclared<T, Set, SomewhereDbValues>; increment?: SomewhereDbIncrementFor<T> | null }
  | { set?: never; increment: SomewhereDbIncrementFor<T> }
);
interface SomewhereDbResult<Row = Record<string, unknown>> {
  // Composed results return db/schema.ts's declared types, as the browser data
  // client does: boolean columns as true/false, json columns as their value,
  // blob columns as byte arrays. Raw query/batch rows are exactly as stored.
  data: Row[];
  error: null;
  count: number;
  changes: number;
  last_row_id: number | string | null;
  live_delivery?: { delivery: 'invalidated' }
    | { delivery: 'resync_required'; reason: string };
}
interface SomewhereRawDbStatement {
  sql: string;
  params?: readonly unknown[];
}
interface SomewhereRawBatchResult {
  data: Record<string, unknown>[];
  changes: number;
  last_row_id: number | string | null;
}
interface SomewhereServerDb {
  query(sql: string, params?: readonly unknown[]): Promise<SomewhereDbResult>;
  batch(statements: readonly SomewhereRawDbStatement[]): Promise<SomewhereRawBatchResult[]>;
  from<T extends SomewhereDbTable, const C extends readonly SomewhereDbColumn<T>[] = readonly SomewhereDbColumn<T>[], const I extends readonly SomewhereDbRelationName<T>[] = []>(
    table: T, options?: SomewhereDbReadOptionsFor<T, C, I> | null): Promise<SomewhereDbResult<SomewhereDbReadRow<T, C, I>>>;
  count(table: SomewhereDbTable, options?: SomewhereDbCountOptions | null): Promise<{ data: number; error: null }>;
  // Server authority names row identity (owner column or shared authorship) explicitly on insert.
  insert<T extends SomewhereDbTable>(table: T, values: __SomewhereDeclared<T, 'serverInsert', SomewhereDbValues>, options?: SomewhereDbInsertOptions | null): Promise<SomewhereDbResult<SomewhereDbRow<T>>>;
  update<T extends SomewhereDbTable>(table: T, spec: SomewhereDbUpdateFor<T, 'serverSet'>): Promise<SomewhereDbResult<SomewhereDbRow<T>>>;
  remove<T extends SomewhereDbTable>(table: T, spec?: SomewhereDbRemove | null): Promise<SomewhereDbResult<SomewhereDbRow<T>>>;
  // Closed atomic batch, 1-100 intents checked before execution. No callback,
  // reads, SQL, or caller-supplied authority. A lost acknowledgement can have
  // an unknown outcome; a rejection never promises rollback or safe replay.
  tx(intents: readonly SomewhereDbWriteIntent[]): Promise<SomewhereDbResult[]>;
}
interface SomewhereCallerDb extends Omit<SomewhereServerDb, 'from' | 'count' | 'insert' | 'update'> {
  // The platform composes row identity from the verified user.
  insert<T extends SomewhereDbTable>(table: T, values: __SomewhereDeclared<T, 'insert', SomewhereDbValues>, options?: SomewhereDbInsertOptions | null): Promise<SomewhereDbResult<SomewhereDbRow<T>>>;
  update<T extends SomewhereDbTable>(table: T, spec: SomewhereDbUpdateFor<T, 'set'>): Promise<SomewhereDbResult<SomewhereDbRow<T>>>;
  from<T extends SomewhereDbTable, const C extends readonly SomewhereDbColumn<T>[] = readonly SomewhereDbColumn<T>[], const I extends readonly SomewhereDbRelationName<T>[] = []>(
    table: T, options?: (SomewhereDbReadOptionsFor<T, C, I> & { asServer?: true }) | null): Promise<SomewhereDbResult<SomewhereDbReadRow<T, C, I>>>;
  count(table: SomewhereDbTable, options?: (SomewhereDbCountOptions & { asServer?: true }) | null): Promise<{ data: number; error: null }>;
  delete<T extends SomewhereDbTable>(table: T, spec?: SomewhereDbRemove | null): Promise<SomewhereDbResult<SomewhereDbRow<T>>>;
  readonly server: SomewhereServerDb;
}
interface SomewhereAuthUser {
  id: string;
  email: string;
  role?: string;
  display_name?: string | null;
  [key: string]: unknown;
}
interface SomewhereAuthCredentials { email: string; password: string }
type SomewhereCookieLoginResult =
  | { user: SomewhereAuthUser; mfa_required?: never; mfa_token?: never }
  | { mfa_required: true; mfa_token: string; user?: never };
type SomewhereAuthSession = {
  user: SomewhereAuthUser;
  refresh_token: string;
  session_token?: string;
  expires_in?: number;
} & ({ token: string; access_token?: string } | { token?: string; access_token: string });
interface SomewhereRuntimeAuth {
  loginWithCookie(req: Request, email: string, password: string): Promise<SomewhereCookieLoginResult>;
  loginWithCookie(req: Request, credentials: SomewhereAuthCredentials): Promise<SomewhereCookieLoginResult>;
  loginWithCookie(credentials: SomewhereAuthCredentials): Promise<SomewhereCookieLoginResult>;
  setSessionCookies(access: string, refresh: string): void;
  readonly mfa: SomewhereRuntimeAuthMfa;
}
// Every binding the runtime exports to a deployed function, typed from the
// runtime implementation and the routes behind it (runtime-types.test.mjs holds
// the declaration to the runtime's own context builder). Tombstones that always
// throw stay off the type so their failure moves to typecheck.
interface SomewhereRuntimeContext {
  readonly db: SomewhereCallerDb;
  readonly auth: SomewhereRuntimeAuth;
  readonly project_id: string;
  readonly subdomain: string;
  readonly tier: string;
  // The project's environment variables (set with somewhere env).
  readonly env: Readonly<Record<string, string>>;
  readonly request_id: string;
  readonly trace: { readonly id: string | null; readonly span_id: string | null };
  // Route parameters from a dynamic file name such as api/rounds/[id].ts.
  readonly params: Readonly<Record<string, string>>;
  // Legacy aliases of this same object.
  readonly sw: SomewhereRuntimeContext;
  readonly ctx: SomewhereRuntimeContext;
}
// Shared by every namespace: a JSON object whose fields are unknown until narrowed.
type SomewhereJsonObject = { [key: string]: unknown };
// ---- sw.db extras: aggregate, live, scope, tables, caller raw options ----
// sw.db.migrate / sw.db.dump / sw.db.onchange are deliberately undeclared: they always throw in a deployed function.
type __SomewhereDbHavingOperators = { eq: string | number | boolean; ne: string | number | boolean; lt: string | number | boolean; lte: string | number | boolean; gt: string | number | boolean; gte: string | number | boolean };
type SomewhereDbHavingCondition = {
  [K in keyof __SomewhereDbHavingOperators]: Pick<__SomewhereDbHavingOperators, K>
    & Partial<Record<Exclude<keyof __SomewhereDbHavingOperators, K>, never>>
}[keyof __SomewhereDbHavingOperators];
// At least one of count/sum/avg/min/max; count takes no column, the others name one column.
type SomewhereDbAggregateMeasures = {
  count?: true | null; sum?: string | null; avg?: string | null; min?: string | null; max?: string | null;
} & ({ count: true } | { sum: string } | { avg: string } | { min: string } | { max: string });
type SomewhereDbAggregateOptions = SomewhereDbAggregateMeasures & {
  groupBy?: readonly string[] | null;
  where?: SomewhereDbWhere | null;
  has?: Readonly<Record<string, SomewhereDbWhere>> | null;
  // Keys are this call's result keys: count, sum_<col>, avg_<col>, min_<col>, max_<col>.
  having?: Readonly<Record<string, SomewhereDbHavingCondition | readonly SomewhereDbHavingCondition[]>> | null;
  // May name only a groupBy column or a result key.
  order?: SomewhereDbOrder | null;
  limit?: number | null;
};
// A declared table names only its own columns: sum/avg its numeric ones,
// min/max/groupBy any but json/blob, and its rows hold scalars, as the browser
// data client's aggregate does.
type SomewhereDbAggregateOptionsFor<T extends string> = SomewhereDbAggregateOptions & {
  sum?: __SomewhereDeclared<T, 'numeric', string> | null;
  avg?: __SomewhereDeclared<T, 'numeric', string> | null;
  min?: __SomewhereDeclared<T, 'scalar', string> | null;
  max?: __SomewhereDeclared<T, 'scalar', string> | null;
  groupBy?: readonly __SomewhereDeclared<T, 'scalar', string>[] | null;
};
type SomewhereDbAggregateRow<T extends string> = T extends keyof SomewhereDeclaredTables
  ? Record<string, number | string | boolean | null>
  : Record<string, unknown>;
interface SomewhereDbAggregateResult<Row = Record<string, unknown>> {
  // Always an array of group rows (exactly one when ungrouped): grouped columns plus composed result keys.
  data: Row[];
  error: null;
  // Number of rows (groups) returned; the COUNT(*) value lives in each row under "count".
  count: number;
}
// Legacy raw-SQL annotations: accepted and ignored, they confer no authority. { user } throws.
interface SomewhereDbRawCallerOptions { unscoped?: true | null; asServer?: true | null; user?: never }
type SomewhereDbLiveState =
  | { name: string; state: 'ready'; release_id?: string; fingerprint: string; subscribe_url: string; expires_at: number }
  | { name: string; state: 'resync_required'; reason: string };
type SomewhereDbLiveResult<Row = Record<string, unknown>> = SomewhereDbResult<Row> & { live: SomewhereDbLiveState };
type SomewhereDbScopeDeclaration =
  | { intent?: 'scoped' | null; owner_column: string; sensitive_columns?: readonly string[] | null }
  | { intent: 'shared' | 'server_only'; owner_column?: string | null; sensitive_columns?: readonly string[] | null };
interface SomewhereDbScopeEntry {
  table: string;
  owner_column: string | null;
  intent: 'scoped' | 'shared' | 'server_only' | 'member' | 'policy';
  sensitive_columns: string[];
  created_at: string;
}
interface SomewhereDbScopeActivation {
  status: 'rebaked' | 'partial' | 'stale' | 'no_functions';
  slots: SomewhereJsonObject[];
  rebaked: SomewhereJsonObject[];
  stale: SomewhereJsonObject[];
}
type SomewhereDbScopeDeclareResult =
  | {
    saved?: never;
    project_id: string;
    table: string;
    owner_column: string | null;
    intent: 'scoped' | 'shared' | 'server_only';
    sensitive_columns: string[];
    scope_activation: SomewhereDbScopeActivation;
    scope_warnings: { code: string; message: string }[];
  }
  // Saved, but activates only on the next deploy or publish.
  | { saved: true; activates_on: 'next_deploy_or_publish' };
interface SomewhereDbScopeApi {
  (table: string, options: SomewhereDbScopeDeclaration): Promise<SomewhereDbScopeDeclareResult>;
  get(table: string): Promise<SomewhereDbScopeEntry | null>;
  list(): Promise<SomewhereDbScopeEntry[]>;
}
interface SomewhereServerDb {
  aggregate<T extends SomewhereDbTable>(table: T, options: SomewhereDbAggregateOptionsFor<T>): Promise<SomewhereDbAggregateResult<SomewhereDbAggregateRow<T>>>;
}
interface SomewhereCallerDb {
  query(sql: string, params?: readonly unknown[] | null, options?: SomewhereDbRawCallerOptions | null): Promise<SomewhereDbResult>;
  batch(statements: readonly SomewhereRawDbStatement[], options?: SomewhereDbRawCallerOptions | null): Promise<SomewhereRawBatchResult[]>;
  aggregate<T extends SomewhereDbTable>(table: T, options: SomewhereDbAggregateOptionsFor<T> & { asServer?: true }): Promise<SomewhereDbAggregateResult<SomewhereDbAggregateRow<T>>>;
  // read must be the exact sw.db.from(...) result (or its promise) this release declares under name.
  live<Row>(name: string, read: SomewhereDbResult<Row> | PromiseLike<SomewhereDbResult<Row>>): Promise<SomewhereDbLiveResult<Row>>;
  tables(): Promise<string[]>;
  readonly scope: SomewhereDbScopeApi;
}

// ---- sw.postgres: the @neondatabase/serverless 1.1.0 neon() callable for the attached database ----
// Unattached projects get the same shape; every call throws POSTGRES_NOT_ATTACHED.
type __SomewherePostgresRows<ArrayMode extends boolean> = ArrayMode extends true ? unknown[][] : Record<string, unknown>[];
interface SomewherePostgresFullResults<ArrayMode extends boolean> {
  fields: { name: string; tableID: number; columnID: number; dataTypeID: number; dataTypeSize: number; dataTypeModifier: number; format: string }[];
  command: string;
  rowCount: number;
  rows: __SomewherePostgresRows<ArrayMode>;
  rowAsArray: ArrayMode;
}
type __SomewherePostgresResult<ArrayMode extends boolean, FullResults extends boolean> =
  FullResults extends true ? SomewherePostgresFullResults<ArrayMode> : __SomewherePostgresRows<ArrayMode>;
interface SomewherePostgresQueryOptions<ArrayMode extends boolean, FullResults extends boolean> {
  arrayMode?: ArrayMode;
  fullResults?: FullResults;
  fetchOptions?: Readonly<Record<string, unknown>>;
  authToken?: string | (() => Promise<string> | string);
  types?: { getTypeParser: (...args: never[]) => unknown };
  disableWarningInBrowsers?: boolean;
}
interface SomewherePostgresTransactionOptions<ArrayMode extends boolean, FullResults extends boolean>
  extends SomewherePostgresQueryOptions<ArrayMode, FullResults> {
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  readOnly?: boolean;
  deferrable?: boolean;
}
// A pending driver query: awaitable, and accepted by transaction([...]) because it carries its queryData.
interface SomewherePostgresQuery<T> extends Promise<T> { readonly queryData: unknown }
interface SomewherePostgresUnsafeRawSql { sql: string }
interface SomewherePostgresInTransaction {
  (strings: TemplateStringsArray, ...params: unknown[]): SomewherePostgresQuery<Record<string, unknown>[]>;
  query(text: string, params?: readonly unknown[]): SomewherePostgresQuery<Record<string, unknown>[]>;
  unsafe(rawSql: string): SomewherePostgresUnsafeRawSql;
}
interface SomewhereRuntimePostgres {
  (strings: TemplateStringsArray, ...params: unknown[]): SomewherePostgresQuery<Record<string, unknown>[]>;
  query<ArrayMode extends boolean = false, FullResults extends boolean = false>(
    text: string, params?: readonly unknown[], options?: SomewherePostgresQueryOptions<ArrayMode, FullResults>,
  ): SomewherePostgresQuery<__SomewherePostgresResult<ArrayMode, FullResults>>;
  // Embeds a trusted raw SQL fragment inside a tagged template; never pass user input.
  unsafe(rawSql: string): SomewherePostgresUnsafeRawSql;
  // Non-interactive: the statement list is fixed before the call and applied atomically.
  transaction<ArrayMode extends boolean = false, FullResults extends boolean = false>(
    queries: readonly SomewherePostgresQuery<unknown>[] | ((sql: SomewherePostgresInTransaction) => readonly SomewherePostgresQuery<unknown>[]),
    options?: SomewherePostgresTransactionOptions<ArrayMode, FullResults>,
  ): Promise<__SomewherePostgresResult<ArrayMode, FullResults>[]>;
}
interface SomewhereRuntimeContext { readonly postgres: SomewhereRuntimePostgres }
// ---- sw.auth (worker/src/runtime/auth.ts) + sw.crypto (worker/src/runtime/crypto.ts) ----
type SomewhereAuthRole = 'user' | 'admin';
// The user a sign-in route returns (signup/login/OTP/OAuth/MFA challenge).
interface SomewhereAuthSignedInUser extends SomewhereAuthUser {
  role: string;
  display_name: string | null;
}
// The verified profile /v1/auth/me returns; fromRequest/requireUser return it (plus enrichFrom columns; platform fields win).
interface SomewhereAuthProfileUser extends SomewhereAuthUser {
  role: SomewhereAuthRole;
  display_name: string | null;
  email_verified: boolean;
  banned: boolean;
  metadata: unknown;
  type: string;
  created_at: number;
  last_login_at: number | null;
  locale?: string | null;
  timezone?: string | null;
  agent?: SomewhereJsonObject;
}
interface SomewhereAuthIssuedSession {
  user: SomewhereAuthSignedInUser;
  token: string;
  access_token: string;
  refresh_token: string;
  session_token: string;
  expires_in: number;
  mfa_required?: never;
  mfa_token?: never;
}
interface SomewhereAuthMfaRequired {
  mfa_required: true;
  mfa_token: string;
  user?: never;
  token?: never;
  access_token?: never;
  refresh_token?: never;
}
type SomewhereAuthLoginResult = SomewhereAuthIssuedSession | SomewhereAuthMfaRequired;
interface SomewhereAuthOtpSession extends SomewhereAuthIssuedSession {
  // The redirect_uri passed to signInWithOtp, or null. For an invitation
  // link: the invite's redirect_uri with ?invite_id=<id> added.
  redirect_uri: string | null;
  // Present when the verified token was an invitation.
  invite_id?: string;
}
type SomewhereAuthInviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
interface SomewhereAuthInvite {
  id: string;
  email: string;
  status: SomewhereAuthInviteStatus;
  redirect_uri: string;
  // Server-side only; never in the email or the link.
  data: SomewhereJsonObject | null;
  expires_at: number;
  created_at: number;
  accepted_at: number | null;
  accepted_user_id: string | null;
  revoked_at: number | null;
}
interface SomewhereAuthInviteOptions {
  email: string;
  // A path in the app such as '/join', or an allowed absolute URL.
  redirect_uri: string;
  // At most 4096 bytes of JSON.
  data?: SomewhereJsonObject;
  // Seconds, 900 to 2592000; default 604800 (7 days).
  expires_in?: number;
}
interface SomewhereAuthInviteSent {
  invite: SomewhereAuthInvite;
  delivery: 'sent' | 'pending';
  message_id?: string;
}
interface SomewhereAuthOAuthSession {
  user: SomewhereAuthSignedInUser;
  token: string;
  refresh_token: string;
  session_token?: string;
}
interface SomewhereAuthGoogleSession {
  user: SomewhereAuthSignedInUser;
  token: string;
  refresh_token?: string;
  session_token?: string;
}
interface SomewhereAuthRefreshed {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
}
interface SomewhereAuthSignupProfile {
  display_name?: string | null;
  displayName?: string | null;
  full_name?: string | null;
  fullName?: string | null;
  name?: string | null;
  locale?: string;
  timezone?: string;
  turnstile_token?: string;
}
interface SomewhereAuthSignupOptions extends SomewhereAuthSignupProfile { email: string; password: string }
type SomewhereAuthLogoutOptions =
  | { session_token: string; refresh_token?: string }
  | { session_token?: string; refresh_token: string };
interface SomewhereAuthMessage { message: string }
type SomewhereAuthOtpSent = SomewhereAuthMessage | { status: 'pending'; message_id: string; message: string };
type SomewhereAuthVerificationSent =
  | { already_verified: true }
  | { sent: true; code_created: true; expires_in_seconds: number }
  | { sent: boolean; code_created: false; pending: true; code: 'EMAIL_SEND_PENDING'; message: string };
interface SomewhereAuthProfileUpdate {
  display_name?: string | null;
  // Replaces the stored metadata blob (JSON, max 16 KB); null clears it.
  metadata?: __SomewhereJson;
  email?: never;
}
interface SomewhereAuthEmailChangeRequest {
  email: string;
  current_password?: string;
  display_name?: never;
  metadata?: never;
}
interface SomewhereAuthUpdatedUser extends SomewhereAuthUser {
  role: SomewhereAuthRole;
  display_name: string | null;
  email_verified: boolean;
  created_at: number;
  last_login_at: number | null;
  metadata: unknown;
}
interface SomewhereAuthEmailChange {
  id: string;
  new_email: string;
  phase: string;
  pending?: true;
  expires_in_seconds?: number;
}
type SomewhereAuthEmailChangeStarted = { email_change: SomewhereAuthEmailChange } & SomewhereJsonObject;
// Options for fromRequest / requireUser: optional enrichment join and an explicitly forwarded app-user token.
interface SomewhereAuthRequestOptions {
  enrichFrom?: string;
  fields?: readonly string[];
  on?: string;
  // A platform-issued app-user access token string; never an identity value.
  forwardedToken?: string | null;
}
interface SomewhereAuthRequireOptions extends SomewhereAuthRequestOptions { role?: 'admin' }
interface SomewhereAuthAnonSession { id: string; isAnon: true; expiresAt: number }
interface SomewhereAuthModerationRevoked { revoked_sessions: number; revoked_refresh_tokens: number }
interface SomewhereRuntimeAuthModeration {
  ban(req: Request, userId: string, options?: { reason?: string | null } | null): Promise<SomewhereAuthModerationRevoked & {
    user: { id: string; email: string; banned: true; banned_reason: string | null };
  }>;
  unban(req: Request, userId: string): Promise<{ user: { id: string; email: string; banned: false } }>;
  deleteUser(req: Request, userId: string): Promise<{ deleted: true; user_id: string }>;
  revokeSessions(req: Request, userId: string): Promise<SomewhereAuthModerationRevoked>;
  setRole(req: Request, userId: string, role: SomewhereAuthRole): Promise<SomewhereAuthModerationRevoked & {
    user: { id: string; email: string; role: SomewhereAuthRole };
  }>;
}
// Email sign-in codes (tsk_8fe91eb5). Authenticator-app activation (reauthenticate*) answers 501 AUTH_FEATURE_UNAVAILABLE.
type SomewhereMfaDelivery = 'sent' | 'pending' | 'unknown';
interface SomewhereMfaCodeSent { challenge_id: string; delivery: SomewhereMfaDelivery; expires_in: number }
type SomewhereMfaRecovery =
  | { removal_pending: true; removes_at: string; wait_seconds: number; notice_resent?: boolean }
  | { enrolled: false };
interface SomewhereRuntimeAuthMfa {
  challenge(options: { mfa_token: string; code: string }): Promise<SomewhereAuthSession>;
  challengeWithCookie(options: { mfa_token: string; code: string }): Promise<{ user: SomewhereAuthUser }>;
  resend(options: { mfa_token: string }): Promise<{ sent: boolean; delivery: SomewhereMfaDelivery; expires_in: number }>;
  enroll(options: { token: string }): Promise<SomewhereMfaCodeSent | { enrolled: true; method: 'email' }>;
  verify(options: { token: string; challenge_id: string; code: string }): Promise<{ enrolled: true; method: 'email' }>;
  unenroll(options: { token: string; password: string }): Promise<SomewhereMfaCodeSent | { enrolled: false }>;
  unenroll(options: { token: string; challenge_id: string; code: string }): Promise<{ enrolled: false }>;
  recover(options: { email: string; password: string }): Promise<SomewhereMfaRecovery>;
  cancelRecovery(options: { token: string }): Promise<{ outcome: 'cancelled' | 'already_closed' | 'completed'; message: string }>;
  reauthenticate(options: { token: string; enrollment_id: string; method: 'password' | 'email'; password?: string }): Promise<never>;
  verifyReauthentication(options: { token: string; enrollment_id: string; challenge_id: string; code: string }): Promise<never>;
  // The same steps for the request's own session (cookie or Bearer). Turning codes on or off ends no session.
  enrollWithCookie(req: Request): Promise<SomewhereMfaCodeSent | { enrolled: true; method: 'email' }>;
  verifyWithCookie(req: Request, options: { challenge_id: string; code: string }): Promise<{ enrolled: true; method: 'email' }>;
  unenrollWithCookie(req: Request, options: { password: string }): Promise<SomewhereMfaCodeSent | { enrolled: false }>;
  unenrollWithCookie(req: Request, options: { challenge_id: string; code: string }): Promise<{ enrolled: false }>;
  reauthenticateWithCookie(req: Request, options: { enrollment_id: string; method: 'password' | 'email'; password?: string }): Promise<never>;
  verifyReauthenticationWithCookie(req: Request, options: { enrollment_id: string; challenge_id: string; code: string }): Promise<never>;
}
interface SomewhereRuntimeAuth {
  signup(options: SomewhereAuthSignupOptions): Promise<SomewhereAuthIssuedSession>;
  login(options: SomewhereAuthCredentials): Promise<SomewhereAuthLoginResult>;
  logout(options: SomewhereAuthLogoutOptions): Promise<{ logged_out: true }>;
  refresh(options: { refresh_token: string }): Promise<SomewhereAuthRefreshed>;
  // Verifies an app-user access token; throws on an invalid/expired token (no null result).
  me(token: string, options?: { refreshToken?: string | null; noCache?: boolean } | null): Promise<{ user: SomewhereAuthProfileUser }>;
  // Resolves the signed-in user from cookie or Bearer (or options.forwardedToken); null when absent/rejected.
  fromRequest(req: Request | null, options?: SomewhereAuthRequestOptions | null): Promise<SomewhereAuthProfileUser | null>;
  // Throws 401 AUTH_REQUIRED when signed out; role 'admin' throws 403 FORBIDDEN for non-admins.
  requireUser(req: Request | null, options?: SomewhereAuthRequireOptions | null): Promise<SomewhereAuthProfileUser>;
  requireRole(req: Request | null, role: 'admin', options?: SomewhereAuthRequestOptions | null): Promise<SomewhereAuthProfileUser>;
  forgot(options: { email: string }): Promise<SomewhereAuthMessage>;
  reset(options: { token: string; new_password: string }): Promise<SomewhereAuthMessage>;
  requestEmailVerification(token: string): Promise<SomewhereAuthVerificationSent>;
  resendVerification(token: string): Promise<SomewhereAuthVerificationSent>;
  verifyEmail(token: string, options: { code: string }): Promise<{ verified: true }>;
  updatePassword(token: string, options: { new_password: string; current_password?: string }): Promise<{ updated: true }>;
  updateProfile(token: string, options: SomewhereAuthProfileUpdate): Promise<{ user: SomewhereAuthUpdatedUser }>;
  // Email change is verify-gated: sends a code, never writes the address immediately.
  updateProfile(token: string, options: SomewhereAuthEmailChangeRequest): Promise<SomewhereAuthEmailChangeStarted>;
  updateProfileWithCookie(req: Request, options: SomewhereAuthProfileUpdate): Promise<{ user: SomewhereAuthUpdatedUser }>;
  updateProfileWithCookie(req: Request, options: SomewhereAuthEmailChangeRequest): Promise<{ email_change: SomewhereAuthEmailChange }>;
  // Email change steps for the request's own session: change_id is email_change.id, code the 6-digit emailed code.
  verifyEmailChangeCurrentWithCookie(req: Request, options: { change_id: string; code: string }): Promise<SomewhereAuthVerificationSent>;
  verifyEmailChangeWithCookie(req: Request, options: { change_id: string; code: string }): Promise<{ changed: true; email: string }>;
  // Email verification for the request's own session (cookie or Bearer); no token in app code.
  requestEmailVerificationWithCookie(req: Request): Promise<SomewhereAuthVerificationSent>;
  verifyEmailWithCookie(req: Request, options: { code: string }): Promise<{ verified: true }>;
  deleteUser(token: string): Promise<{ deleted: true }>;
  // Password change and account deletion end every session of the account; these clear the cookies.
  updatePasswordWithCookie(req: Request, options: { new_password: string; current_password?: string }): Promise<{ updated: true }>;
  deleteUserWithCookie(req: Request): Promise<{ deleted: true }>;
  // Start Google/GitHub/Discord sign-in from a server handler: stages this attempt's HttpOnly
  // verifier cookie on the response and resolves the provider start URL (only its challenge travels).
  oauthStart(provider: 'google' | 'github' | 'discord', options: { redirect_uri: string }): Promise<string>;
  /** @deprecated Always throws OAUTH_START_REQUIRES_BINDING: sign-in is bound to the browser that starts it. Use: Response.redirect(await sw.auth.oauthStart('google', { redirect_uri }), 302). The parameter stays assignable so apps on older SDK types still typecheck. */
  googleUrl(options: { redirect_uri: string }): never;
  /** @deprecated Always throws OAUTH_START_REQUIRES_BINDING: sign-in is bound to the browser that starts it. Use: Response.redirect(await sw.auth.oauthStart('github', { redirect_uri }), 302). The parameter stays assignable so apps on older SDK types still typecheck. */
  githubUrl(options: { redirect_uri: string }): never;
  /** @deprecated Always throws OAUTH_START_REQUIRES_BINDING: sign-in is bound to the browser that starts it. Use: Response.redirect(await sw.auth.oauthStart('discord', { redirect_uri }), 302). The parameter stays assignable so apps on older SDK types still typecheck. */
  discordUrl(options: { redirect_uri: string }): never;
  // Exchanges take the callback's ?code= and its public ?attempt= (which selects this browser's attempt cookie).
  googleExchange(options: { code: string; attempt: string; redirect_uri?: string }): Promise<SomewhereAuthGoogleSession>;
  githubExchange(options: { code: string; attempt: string }): Promise<SomewhereAuthOAuthSession>;
  discordExchange(options: { code: string; attempt: string }): Promise<SomewhereAuthOAuthSession>;
  // Reads ?code and ?attempt, exchanges with that attempt's oauthStart verifier from this request,
  // stages the session cookies, clears that attempt, returns a 302 to redirectTo (default '/').
  googleCallbackWithCookie(req: Request, redirectTo?: string): Promise<Response>;
  githubCallbackWithCookie(req: Request, redirectTo?: string): Promise<Response>;
  discordCallbackWithCookie(req: Request, redirectTo?: string): Promise<Response>;
  signupWithCookie(req: Request, email: string, password: string, options?: SomewhereAuthSignupProfile | string | null): Promise<{ user: SomewhereAuthUser }>;
  signupWithCookie(req: Request, options: SomewhereAuthSignupOptions): Promise<{ user: SomewhereAuthUser }>;
  signupWithCookie(options: SomewhereAuthSignupOptions): Promise<{ user: SomewhereAuthUser }>;
  clearSessionCookies(): void;
  logoutWithCookie(req: Request): Promise<{ ok: true }>;
  signInWithOtp(options: { email: string; redirect_uri?: string }): Promise<SomewhereAuthOtpSent>;
  verifyOtp(options: { token: string }): Promise<SomewhereAuthOtpSession>;
  // One invite email; the link signs the invitee in as the invited address.
  invite(options: SomewhereAuthInviteOptions): Promise<SomewhereAuthInviteSent>;
  listInvites(options?: { status?: SomewhereAuthInviteStatus; email?: string; limit?: number }): Promise<SomewhereAuthInvite[]>;
  getInvite(id: string): Promise<SomewhereAuthInvite | null>;
  revokeInvite(id: string): Promise<SomewhereAuthInvite>;
  // The accepted invite, only for the signed-in account that accepted it;
  // otherwise throws INVITE_NOT_ACCEPTED_BY_YOU (403) or AUTH_REQUIRED (401).
  getAcceptedInvite(req: Request, id: string): Promise<SomewhereAuthInvite>;
  anonSession(): Promise<SomewhereAuthAnonSession>;
  readonly moderation: SomewhereRuntimeAuthModeration;
}
interface SomewhereRuntimeCrypto {
  // Lowercase hex HMAC-SHA256 of message keyed by secret.
  hmacSha256Hex(message: string, secret: string): Promise<string>;
  timingSafeEqual(a: string, b: string): boolean;
  readonly bcrypt: {
    // Verify-only; there is no hashing surface.
    verify(password: string, hash: string): Promise<boolean>;
  };
}
interface SomewhereRuntimeContext { readonly crypto: SomewhereRuntimeCrypto }
// ---- sw.payments / sw.quote / sw.connect / sw.billing / sw.calendar ----
type SomewherePaymentsEnv = 'dev' | 'prod';
type SomewherePaymentsStripeMode = 'test' | 'live';

// Quote input (sw.quote / sw.payments.quote). Amounts are integer cents.
type SomewhereQuoteFeeKind = 'flat' | 'per_night' | 'per_guest' | 'per_guest_per_night';
interface SomewhereQuoteRateCalendarEntry { start?: string; end?: string; amount?: number; label?: string; weekdays?: readonly number[] }
interface SomewhereQuoteBaseRate {
  amount?: number;
  unit?: 'flat' | 'night';
  calendar?: readonly SomewhereQuoteRateCalendarEntry[];
  rate_calendar?: readonly SomewhereQuoteRateCalendarEntry[];
  weekday?: Readonly<Record<string, number>>;
  weekdays?: Readonly<Record<string, number>>;
}
interface SomewhereQuoteFee { name?: string; label?: string; amount?: number; kind?: SomewhereQuoteFeeKind; type?: SomewhereQuoteFeeKind; taxable?: boolean }
interface SomewhereQuoteDiscountSpec {
  name?: string; label?: string; code?: string; promo?: string;
  amount?: number; percent?: number; percent_bps?: number;
  min_nights?: number; minNights?: number; min_guests?: number; minGuests?: number;
}
interface SomewhereQuoteTaxSpec { rate_bps?: number; rate?: number; stripe?: boolean; tax_code?: string; tax_behavior?: 'exclusive' | 'inclusive' }
interface SomewhereQuoteDepositSpec { amount?: number; percent?: number; percent_bps?: number; capture_method?: 'manual' | 'automatic' }
interface SomewhereQuoteResource {
  id?: string;
  name?: string;
  currency?: string;
  baseRate?: number | SomewhereQuoteBaseRate;
  base_rate?: number | SomewhereQuoteBaseRate;
  rate?: number | SomewhereQuoteBaseRate;
  rateCalendar?: readonly SomewhereQuoteRateCalendarEntry[];
  rate_calendar?: readonly SomewhereQuoteRateCalendarEntry[];
  fees?: readonly SomewhereQuoteFee[];
  discounts?: readonly SomewhereQuoteDiscountSpec[];
  promo_codes?: readonly SomewhereQuoteDiscountSpec[];
  promoCodes?: readonly SomewhereQuoteDiscountSpec[];
  tax?: SomewhereQuoteTaxSpec;
  deposit?: number | SomewhereQuoteDepositSpec;
}
// Date-only 'YYYY-MM-DD' values, 1 to 366 nights.
type SomewhereQuoteRange = { start?: string; end?: string; from?: string; to?: string } | readonly [string, string];
interface SomewhereQuoteOptions {
  env?: SomewherePaymentsEnv;
  guests?: number;
  promo?: string;
  // Required when resource.tax.stripe is true; fields follow Stripe Tax calculation params.
  tax?: { customer_details?: SomewhereJsonObject; ship_from_details?: SomewhereJsonObject; tax_date?: number };
  booking?: {
    id?: string;
    external_id?: string;
    externalId?: string;
    // Derived from the signed-in app user; a different or subjectless value is refused.
    app_user_id?: string;
    appUserId?: string;
    metadata?: SomewhereJsonObject;
  };
}
interface SomewhereQuoteLineItem {
  id: string;
  kind: 'base' | 'fee' | 'tax' | 'deposit';
  name: string;
  amount: number;
  currency: string;
  quantity: number;
  taxable: boolean;
  source?: string;
}
interface SomewhereQuoteResult {
  quote_id: string;
  booking_id: string;
  expires_at: string;
  resource: { id: string | null; name: string };
  range: { start: string; end: string; nights: number };
  guests: number;
  promo: string | null;
  currency: string;
  subtotal: number;
  taxes: { amount: number; source: 'none' | 'local' | 'stripe_tax'; calculation_id?: string | null; breakdown?: unknown };
  deposit: { amount: number; capture_method: 'manual' | 'automatic' };
  total: number;
  lineItems: SomewhereQuoteLineItem[];
  discounts: { name: string; amount: number; source: 'tier' | 'promo' }[];
}
type SomewhereQuoteFunction = (resource: SomewhereQuoteResource, range: SomewhereQuoteRange, opts?: SomewhereQuoteOptions | null) => Promise<SomewhereQuoteResult>;

// Payments
interface SomewherePaymentsOnboardOptions { return_url?: string; refresh_url?: string; mode?: SomewherePaymentsStripeMode; env?: SomewherePaymentsEnv }
interface SomewherePaymentsOnboardResult {
  account_id: string;
  test_account_id: string;
  onboarding_url: string | null;
  expires_at: string | null;
  mode: SomewherePaymentsStripeMode;
  test_only: boolean;
  // Present on test-mode onboarding only.
  charges_enabled?: boolean;
  checkout_ready?: boolean;
  platform_fee_percent: number;
  platform_fee_note: string | null;
}
type SomewherePaymentsStatus =
  | { connected: false; onboarded: false; charges_enabled: false; payouts_enabled: false }
  | {
    connected: boolean;
    account_id: string | null;
    test_account_id: string | null;
    onboarded: boolean;
    charges_enabled: boolean;
    payouts_enabled: boolean;
    details_submitted: boolean;
    country: string | null;
    default_currency: string | null;
  };
interface SomewherePaymentsLineItem { price?: string; amount?: number; currency?: string; name?: string; quantity?: number }
interface SomewherePaymentsCheckoutOptions {
  row?: never;
  env?: SomewherePaymentsEnv;
  mode?: 'payment' | 'subscription';
  line_items?: readonly SomewherePaymentsLineItem[];
  quote_id?: string;
  booking_id?: string;
  calendar_hold_token?: string;
  // Catalog plan slug (sw.billing); resolves its stripe_price_id when line_items is empty.
  plan?: string;
  success_url: string;
  cancel_url: string;
  customer_email?: string;
  metadata?: Readonly<Record<string, string>>;
}
/** Row checkout is a live, one-time payment; amounts are integer cents and items use one currency. */
interface SomewherePaymentsRowCheckoutLineItem {
  name: string;
  amount: number;
  currency: string;
  quantity?: number;
  price?: never;
}
interface SomewherePaymentsRowCheckoutOptions {
  row: { binding: string; id: string | number };
  env?: 'prod';
  mode?: 'payment';
  line_items: readonly SomewherePaymentsRowCheckoutLineItem[];
  success_url: string;
  cancel_url: string;
  customer_email?: string;
  metadata?: never;
  quote_id?: never;
  booking_id?: never;
  calendar_hold_token?: never;
  plan?: never;
}
interface SomewherePaymentsRowCheckoutSessionResult {
  binding_id: string;
  session_id: string;
  url: string | null;
  reused: boolean;
  stripe_mode: 'live';
  amount_total_cents: number;
  currency: string;
}
/** A pending result has no checkout URL; reconciliation_required:true needs operator reconciliation. */
interface SomewherePaymentsRowCheckoutPendingResult {
  binding_id: string;
  status: 'pending';
  reconciliation_required: boolean;
}
type SomewherePaymentsRowCheckoutResult = SomewherePaymentsRowCheckoutSessionResult | SomewherePaymentsRowCheckoutPendingResult;
interface SomewherePaymentsCheckoutForUserOptions extends SomewherePaymentsCheckoutOptions { plan: string }
interface SomewherePaymentsCheckoutResult {
  session_id: string;
  url: string | null;
  amount_total_cents: number;
  platform_fee_cents: number;
  fee_percent: number;
  stripe_mode: SomewherePaymentsStripeMode;
  is_stand_in: boolean;
  checkout_intent_id: string | null;
  quote_id: string | null;
  booking_id: string | null;
  capture_method: 'manual' | 'automatic';
  payment_intent_id: string | null;
}
type SomewherePaymentsRefundOptions = {
  amount?: number;
  reason?: 'requested_by_customer' | 'duplicate' | 'fraudulent';
  env?: SomewherePaymentsEnv;
  idempotency_key?: string;
} & ({ payment_intent_id: string; charge_id?: string } | { payment_intent_id?: string; charge_id: string });
interface SomewherePaymentsRefundResult {
  refund_id: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  charge_id: string | null;
  payment_intent_id: string | null;
  stripe_mode: SomewherePaymentsStripeMode;
  refund_intent_id: string;
  intent_status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  duplicate?: true;
}
interface SomewherePaymentsCancelSubscriptionOptions { subscription_id: string; immediately?: boolean; env?: SomewherePaymentsEnv }
interface SomewherePaymentsCancelSubscriptionResult {
  subscription_id: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  current_period_end: string | null;
  stripe_mode: SomewherePaymentsStripeMode;
}
interface SomewherePaymentsTransactionsOptions { limit?: number; starting_after?: string | null; startingAfter?: string | null; env?: SomewherePaymentsEnv }
interface SomewherePaymentsTransaction {
  id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: string;
  paid: boolean;
  refunded: boolean;
  created: string;
  customer_id: string | null;
  payment_intent_id: string | null;
  receipt_email: string | null;
  description: string | null;
}
interface SomewherePaymentsTransactionsResult {
  transactions: SomewherePaymentsTransaction[];
  has_more: boolean;
  next_cursor: string | null;
  stripe_mode: SomewherePaymentsStripeMode;
}
type SomewherePaymentsPortalOptions = {
  return_url?: string;
  returnUrl?: string;
  env?: SomewherePaymentsEnv;
} & ({ customer_id: string; customerId?: string } | { customer_id?: string; customerId: string });
interface SomewherePaymentsPortalForUserOptions { return_url?: string; returnUrl?: string; env?: SomewherePaymentsEnv }
interface SomewherePaymentsPortalResult { url: string; stripe_mode: SomewherePaymentsStripeMode }
interface SomewherePaymentsEventsOptions { limit?: number; before?: number | null; type?: string }
interface SomewherePaymentsEvent {
  id: string;
  type: string;
  mode: string;
  account_id: string | null;
  project_id: string | null;
  amount_cents: number | null;
  currency: string | null;
  livemode: boolean;
  received_at: string;
}
// next_cursor is an epoch-ms number; pass it back as before.
interface SomewherePaymentsEventsResult { events: SomewherePaymentsEvent[]; next_cursor: number | null }
interface SomewhereRuntimePayments {
  onboard(opts?: SomewherePaymentsOnboardOptions | null): Promise<SomewherePaymentsOnboardResult>;
  quote: SomewhereQuoteFunction;
  status(opts?: { refresh?: boolean } | null): Promise<SomewherePaymentsStatus>;
  checkout(opts: SomewherePaymentsRowCheckoutOptions): Promise<SomewherePaymentsRowCheckoutResult>;
  checkout(opts: SomewherePaymentsCheckoutOptions): Promise<SomewherePaymentsCheckoutResult>;
  // The app user is the request's verified principal; no user id argument.
  checkoutForUser(opts: SomewherePaymentsCheckoutForUserOptions): Promise<SomewherePaymentsCheckoutResult>;
  dashboardLink(): Promise<{ url: string }>;
  refund(opts: SomewherePaymentsRefundOptions): Promise<SomewherePaymentsRefundResult>;
  cancelSubscription(opts: SomewherePaymentsCancelSubscriptionOptions): Promise<SomewherePaymentsCancelSubscriptionResult>;
  transactions(opts?: SomewherePaymentsTransactionsOptions | null): Promise<SomewherePaymentsTransactionsResult>;
  portal(opts: SomewherePaymentsPortalOptions): Promise<SomewherePaymentsPortalResult>;
  // The app user is the request's verified principal; no user id argument.
  portalForUser(opts: SomewherePaymentsPortalForUserOptions): Promise<SomewherePaymentsPortalResult>;
  events(opts?: SomewherePaymentsEventsOptions | null): Promise<SomewherePaymentsEventsResult>;
}

// Connect (read-only link to a creator's existing Stripe account)
interface SomewhereConnectStripeStatus {
  connected: boolean;
  account_id: string | null;
  scope: string | null;
  status: string;
  sync_error: string | null;
  connected_at: number | null;
  updated_at: number | null;
}
interface SomewhereConnectStripeSubscriber {
  email: string;
  stripe_customer_id: string | null;
  subscription_id: string | null;
  status: string | null;
  price_id: string | null;
  product_id: string | null;
  tier: string | null;
  current_period_end: number | null;
  amount: number | null;
  currency: string | null;
}
interface SomewhereConnectStripeSubscribersResult {
  data: SomewhereConnectStripeSubscriber[];
  next_cursor: string | null;
  sync_status: 'connected';
  updated_at: number | null;
}
interface SomewhereRuntimeConnectStripe {
  connect(opts?: { return_url?: string; returnUrl?: string } | null): Promise<{ url: string }>;
  status(): Promise<SomewhereConnectStripeStatus>;
  subscribers(opts?: { status?: string; limit?: number; cursor?: string | null } | null): Promise<SomewhereConnectStripeSubscribersResult>;
  disconnect(): Promise<{ ok: true }>;
}
interface SomewhereRuntimeConnect { readonly stripe: SomewhereRuntimeConnectStripe }

// Billing (plan catalog + entitlements for the app's own users)
interface SomewhereBillingPlanFeatureInput { feature: string; limit?: number | null }
interface SomewhereBillingPlanInput {
  slug: string;
  name: string;
  description?: string | null;
  price_cents?: number | null;
  currency?: string;
  interval?: 'month' | 'year' | null;
  stripe_price_id?: string | null;
  sort_order?: number;
  is_default?: boolean;
  active?: boolean;
  features?: readonly (string | SomewhereBillingPlanFeatureInput)[];
}
interface SomewhereBillingPlan {
  slug: string;
  name: string;
  description: string | null;
  price_cents: number | null;
  currency: string;
  interval: string | null;
  stripe_price_id: string | null;
  sort_order: number;
  is_default: boolean;
  active: boolean;
  features: { feature: string; limit_value: number | null }[];
}
interface SomewhereBillingDefinePlansResult { plans: SomewhereBillingPlan[]; retained_plan_slugs: string[]; warning: string | null }
interface SomewhereBillingEntitlements { plan: string; plan_defined: boolean; features: string[]; limits: Record<string, number> }
interface SomewhereRuntimeBilling {
  definePlans(plans: readonly SomewhereBillingPlanInput[]): Promise<SomewhereBillingDefinePlansResult>;
  plans(): Promise<{ plans: SomewhereBillingPlan[] }>;
  // Subject is the request's verified principal; takes only the feature slug.
  has(feature: string): Promise<boolean>;
  entitlements(): Promise<SomewhereBillingEntitlements>;
}

// Calendar. Instants are epoch ms or ISO strings with an explicit Z/offset.
type SomewhereCalendarInstant = string | number;
interface SomewhereCalendarRange { start: SomewhereCalendarInstant; end: SomewhereCalendarInstant; timezone: string }
interface SomewhereCalendarReadRange { start: SomewhereCalendarInstant; end: SomewhereCalendarInstant }
interface SomewhereCalendarRebookRange { start: SomewhereCalendarInstant; end: SomewhereCalendarInstant; timezone?: string | null }
type SomewhereCalendarReservationStatus = 'hold' | 'pending_payment' | 'confirmed' | 'payment_received_slot_lost' | 'released' | 'expired';
interface SomewhereCalendarReservation {
  id: string;
  project_id: string;
  resource: string;
  start_ms: number;
  end_ms: number;
  timezone: string;
  kind: 'reservation' | 'blackout';
  status: SomewhereCalendarReservationStatus;
  hold_token_prefix: string;
  metadata: unknown;
  payment_reference: string | null;
  expires_at: number | null;
  confirmed_at: number | null;
  released_at: number | null;
  release_reason: string | null;
  cancellation_status: 'complete_no_refund' | 'refund_pending' | 'refund_succeeded' | 'refund_failed' | 'refund_unknown' | null;
  cancellation_refund_intent_id: string | null;
  cancellation_refund_error: string | null;
  created_at: number;
  updated_at: number;
}
interface SomewhereCalendarHoldOptions {
  resource: string;
  range: SomewhereCalendarRange;
  // ttl and ttl_seconds are seconds; ttl_ms wins when set. Default 35 min, max 24 h.
  ttl?: number;
  ttl_seconds?: number;
  ttl_ms?: number;
  metadata?: SomewhereJsonObject | null;
}
interface SomewhereCalendarHoldResult { token: string; hold_token: string; expires_at: number; reservation: SomewhereCalendarReservation }
interface SomewhereCalendarBlackoutExtras { reason?: string | null; metadata?: SomewhereJsonObject | null }
interface SomewhereCalendarBlackoutOptions extends SomewhereCalendarBlackoutExtras { resource: string; range: SomewhereCalendarRange }
type __SomewhereCalendarIdRef = { reservation_id: string } | { booking_id: string } | { id: string };
type SomewhereCalendarRemoveBlackoutOptions = ({ reservation_id: string } | { blackout_id: string } | { id: string }) & { reason?: string | null };
interface SomewhereCalendarRefundPolicy { full_before_days: number; partial_percent: number }
interface SomewhereCalendarCancelExtras { reason?: string | null; refund_policy?: SomewhereCalendarRefundPolicy | null }
type SomewhereCalendarCancelOptions = __SomewhereCalendarIdRef & SomewhereCalendarCancelExtras;
type SomewhereCalendarCancelRefund =
  | { refund_id: string; status: string | null; amount: number; currency: string; charge_id: string | null; payment_intent_id: string | null; stripe_mode: SomewherePaymentsStripeMode }
  | { status: 'not_due'; amount: 0; currency: string };
interface SomewhereCalendarCancelResult { canceled: boolean; reservation: SomewhereCalendarReservation; refund: SomewhereCalendarCancelRefund | null }
type SomewhereCalendarRebookOptions = __SomewhereCalendarIdRef & ({ new_range: SomewhereCalendarRebookRange } | { range: SomewhereCalendarRebookRange });
// Each field is optional; null clears it.
interface SomewhereCalendarPolicyInput {
  min_stay_nights?: number | null;
  max_stay_nights?: number | null;
  advance_notice_hours?: number | null;
  bookable_from?: SomewhereCalendarInstant | null;
  turnaround_hours?: number | null;
  // Seats per exact [start, end) class slot. Omitted or null: one reservation per overlapping range.
  capacity?: number | null;
}
type SomewhereCalendarSetPolicyOptions = { resource: string } & ({ policy: SomewhereCalendarPolicyInput } | (SomewhereCalendarPolicyInput & { policy?: never }));
interface SomewhereCalendarPolicy {
  resource: string;
  min_stay_nights: number | null;
  max_stay_nights: number | null;
  advance_notice_hours: number | null;
  bookable_from_ms: number | null;
  turnaround_hours: number | null;
  capacity: number | null;
  created_at: number | null;
  updated_at: number | null;
}
interface SomewhereCalendarAvailabilityResult {
  resource: string;
  range: { start_ms: number; end_ms: number };
  busy: {
    reservation_id: string;
    kind: 'hold' | 'booking' | 'blackout';
    status: 'hold' | 'pending_payment' | 'confirmed';
    start_ms: number;
    end_ms: number;
    expires_at: number | null;
  }[];
  free: { start_ms: number; end_ms: number }[];
  // null for an exclusive resource.
  capacity: number | null;
  // Existing class slots overlapping the range (full ones included); not a schedule.
  slots: { start_ms: number; end_ms: number; capacity: number; reserved: number; remaining: number }[];
}
interface SomewhereCalendarListExtras {
  range?: SomewhereCalendarReadRange | null;
  // Defaults to the active statuses (hold, pending_payment, confirmed).
  statuses?: SomewhereCalendarReservationStatus | readonly SomewhereCalendarReservationStatus[] | null;
  limit?: number | null;
  cursor?: string | null;
}
interface SomewhereCalendarListOptions extends SomewhereCalendarListExtras { resource: string }
interface SomewhereCalendarListResult { reservations: SomewhereCalendarReservation[]; next_cursor: string | null }
interface SomewhereCalendarTokenExtras { payment_reference?: string | null }
interface SomewhereCalendarReleaseExtras extends SomewhereCalendarTokenExtras { release_reason?: string | null }
type __SomewhereCalendarTokenRef = { token: string } | { hold_token: string };
interface SomewhereRuntimeCalendar {
  hold(opts: SomewhereCalendarHoldOptions): Promise<SomewhereCalendarHoldResult>;
  hold(resource: string, range: SomewhereCalendarRange, ttl?: number): Promise<SomewhereCalendarHoldResult>;
  blackout(opts: SomewhereCalendarBlackoutOptions): Promise<{ blackout: SomewhereCalendarReservation }>;
  blackout(resource: string, range: SomewhereCalendarRange, opts?: SomewhereCalendarBlackoutExtras | null): Promise<{ blackout: SomewhereCalendarReservation }>;
  removeBlackout(opts: SomewhereCalendarRemoveBlackoutOptions): Promise<{ removed: boolean; blackout: SomewhereCalendarReservation | null }>;
  removeBlackout(reservationId: string, opts?: { reason?: string | null } | null): Promise<{ removed: boolean; blackout: SomewhereCalendarReservation | null }>;
  cancel(opts: SomewhereCalendarCancelOptions): Promise<SomewhereCalendarCancelResult>;
  cancel(reservationId: string, opts?: SomewhereCalendarCancelExtras | null): Promise<SomewhereCalendarCancelResult>;
  rebook(opts: SomewhereCalendarRebookOptions): Promise<{ rebooked: boolean; reservation: SomewhereCalendarReservation }>;
  rebook(reservationId: string, newRange: SomewhereCalendarRebookRange): Promise<{ rebooked: boolean; reservation: SomewhereCalendarReservation }>;
  setPolicy(opts: SomewhereCalendarSetPolicyOptions): Promise<{ policy: SomewhereCalendarPolicy }>;
  setPolicy(resource: string, policy: SomewhereCalendarPolicyInput): Promise<{ policy: SomewhereCalendarPolicy }>;
  getPolicy(resourceOrOpts: string | { resource: string }): Promise<{ policy: SomewhereCalendarPolicy }>;
  availability(opts: { resource: string; range: SomewhereCalendarReadRange }): Promise<SomewhereCalendarAvailabilityResult>;
  availability(resource: string, range: SomewhereCalendarReadRange): Promise<SomewhereCalendarAvailabilityResult>;
  list(opts: SomewhereCalendarListOptions): Promise<SomewhereCalendarListResult>;
  list(resource: string, opts?: SomewhereCalendarListExtras | null): Promise<SomewhereCalendarListResult>;
  get(idOrOpts: string | __SomewhereCalendarIdRef): Promise<{ reservation: SomewhereCalendarReservation }>;
  pending(opts: __SomewhereCalendarTokenRef & SomewhereCalendarTokenExtras): Promise<{ reservation: SomewhereCalendarReservation }>;
  pending(token: string, opts?: SomewhereCalendarTokenExtras | null): Promise<{ reservation: SomewhereCalendarReservation }>;
  confirm(opts: __SomewhereCalendarTokenRef & SomewhereCalendarTokenExtras): Promise<{ reservation: SomewhereCalendarReservation }>;
  confirm(token: string, opts?: SomewhereCalendarTokenExtras | null): Promise<{ reservation: SomewhereCalendarReservation }>;
  release(opts: __SomewhereCalendarTokenRef & SomewhereCalendarReleaseExtras): Promise<{ released: boolean; reservation: SomewhereCalendarReservation | null }>;
  release(token: string, opts?: SomewhereCalendarReleaseExtras | null): Promise<{ released: boolean; reservation: SomewhereCalendarReservation | null }>;
  expire(opts?: { resource?: string | null } | null): Promise<{ expired: number }>;
}

interface SomewhereRuntimeContext {
  readonly payments: SomewhereRuntimePayments;
  readonly connect: SomewhereRuntimeConnect;
  // Same operation as sw.payments.quote.
  readonly quote: SomewhereQuoteFunction;
  readonly billing: SomewhereRuntimeBilling;
  readonly calendar: SomewhereRuntimeCalendar;
}
// ---- files + utilities: sw.fs, sw.search, sw.image, sw.render, sw.web, sw.fetch, sw.rateLimit, sw.logs, sw.analytics

// Body shape a platform route returns when it refuses a request.
interface SomewhereFsErrorEnvelope {
  ok: false;
  error: string;
  message: string;
  code?: string;
  retry?: boolean;
  retry_after_ms?: number;
  hint?: string;
  data?: SomewhereJsonObject;
}
type SomewhereFsVisibility = 'public' | 'private';
type SomewhereFsOwnerSubjectType = 'app_user' | 'project_owner';
type SomewhereFsWriteBody = string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array>;
interface SomewhereFsWriteOptions {
  contentType?: string;
  content_type?: string;
  visibility?: SomewhereFsVisibility;
  public?: boolean;
  // Refuse with FS_VERSION_CONFLICT when the file's current version differs.
  ifMatch?: number | string | null;
  if_match?: number | string | null;
}
interface SomewhereFsWriteData {
  path: string;
  size_bytes: number;
  content_type: string;
  version: number;
  content_revision: string;
}
// write resolves with the full route envelope; read fields off .data.
interface SomewhereFsWriteResult { ok: true; data: SomewhereFsWriteData }
interface SomewhereFsReadLinesOptions { lines: string | readonly [number, number] }
interface SomewhereFsReadOptions { lines?: string | readonly [number, number] | null }
interface SomewhereFsReadLinesResult {
  path: string;
  content: string;
  lines: [number, number];
  total_lines: number;
  content_type: string | null;
  version: number;
  content_revision: string | null;
}
interface SomewhereFsDeleteData { deleted: number; type: 'file' | 'directory'; path: string }
// delete does not throw on a refused request; it resolves with the error body.
type SomewhereFsDeleteResult = { ok: true; data: SomewhereFsDeleteData } | SomewhereFsErrorEnvelope;
interface SomewhereFsMoveOptions { overwrite?: boolean }
interface SomewhereFsMoveResult { from: string; to: string }
interface SomewhereFsCopyResult { from: string; to: string; content_revision: string }
interface SomewhereFsRestoreResult {
  path: string;
  restored_version: number;
  current_version: number;
  content_revision: string;
}
interface SomewhereFsStat {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size_bytes: number;
  content_type: string | null;
  content_revision: string | null;
  visibility: SomewhereFsVisibility;
  version: number;
  created_at: string;
  updated_at: string;
}
interface SomewhereFsVersion { version: number; size_bytes: number; content_type: string; created_at: string }
interface SomewhereFsVersionsResult { path: string; current_version: number; versions: SomewhereFsVersion[] }
interface SomewhereFsListOptions { recursive?: boolean; depth?: number }
interface SomewhereFsListEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size_bytes: number;
  content_type: string | null;
  version: number;
  updated_at: string;
}
type SomewhereFsListResult =
  | { path: string; type: 'directory'; entries: SomewhereFsListEntry[]; next_cursor: string | null; recursive?: never }
  | { path: string; type: 'directory'; entries: SomewhereFsListEntry[]; recursive: true; depth: number | null };
interface SomewhereFsReplaceOptions { path: string; find: string; replace: string }
interface SomewhereFsReplaceResult {
  ok: true;
  replacements: number;
  path: string;
  version: number;
  size_bytes: number;
  content_revision?: string;
}
interface SomewhereFsUploadUrlOptions {
  path: string;
  maxSize?: number;
  max_size?: number;
  contentType?: string;
  content_type?: string;
  expiresIn?: number;
  expires_in?: number;
}
interface SomewhereFsUploadUrlResult {
  url: string;
  multipart_url: string;
  path: string;
  expires_at: string;
  max_size: number;
  content_type: string;
  public: boolean;
  owner_subject_type: SomewhereFsOwnerSubjectType;
  owner_subject_id: string;
}
interface SomewhereFsSignedUrlOptions { expiresIn?: number; expires_in?: number }
interface SomewhereFsSignedUrlResult { url: string; token: string; path: string; expires_at: string; expires_in: number }
interface SomewhereFsPublicUrlOptions { makePublic?: boolean; make_public?: boolean; public?: boolean }
interface SomewhereFsPublicUrlResult {
  path: string;
  public_url: string;
  content_type: string | null;
  size_bytes: number;
  visibility: 'public';
}
interface SomewhereFsSetOwnerResult {
  path: string;
  owner_subject_type: SomewhereFsOwnerSubjectType;
  owner_subject_id: string;
}
interface SomewhereFsUploadFromRequestOptions {
  path: string;
  maxBytes?: number;
  max_bytes?: number;
  allowedTypes?: readonly string[];
  fieldName?: string;
  field_name?: string;
  public?: boolean;
  visibility?: SomewhereFsVisibility;
}
type SomewhereFsUploadFromRequestResult =
  | { url: string; path: string; size: number; contentType: string; visibility: 'public' }
  | { url: string | null; path: string; size: number; contentType: string; visibility: 'private' };
// Shared by sw.fs (acting user derived from the request) and sw.fs.server (project-wide).
// The project-wide scanners diff/glob/search exist only on sw.fs.dev in run_code.
interface SomewhereFsView {
  read(path: string, options: SomewhereFsReadLinesOptions): Promise<SomewhereFsReadLinesResult>;
  read(path: string, options?: { lines?: null } | null): Promise<Response>;
  read(path: string, options?: SomewhereFsReadOptions | null): Promise<Response | SomewhereFsReadLinesResult>;
  write(path: string, body: SomewhereFsWriteBody, options?: SomewhereFsWriteOptions | null): Promise<SomewhereFsWriteResult>;
  delete(path: string): Promise<SomewhereFsDeleteResult>;
  move(from: string, to: string, options?: SomewhereFsMoveOptions | null): Promise<SomewhereFsMoveResult>;
  copy(from: string, to: string): Promise<SomewhereFsCopyResult>;
  restore(path: string, version: number): Promise<SomewhereFsRestoreResult>;
  stat(path: string): Promise<SomewhereFsStat>;
  versions(path: string): Promise<SomewhereFsVersionsResult>;
  list(path?: string | null, options?: SomewhereFsListOptions | null): Promise<SomewhereFsListResult>;
  replace(options: SomewhereFsReplaceOptions): Promise<SomewhereFsReplaceResult>;
  uploadUrl(options: SomewhereFsUploadUrlOptions): Promise<SomewhereFsUploadUrlResult>;
  signedUrl(path: string, options?: SomewhereFsSignedUrlOptions | null): Promise<SomewhereFsSignedUrlResult>;
  public_url(path: string, options?: SomewhereFsPublicUrlOptions | null): Promise<SomewhereFsPublicUrlResult>;
  publicUrl(path: string, options?: SomewhereFsPublicUrlOptions | null): Promise<SomewhereFsPublicUrlResult>;
  // null resets ownership to the project. On sw.fs.server, { collection, group? }
  // adopts an existing file under that collection's folder into the collection.
  setOwner(path: string, user: string | { readonly id: string } | null, options?: { collection: string; group?: string | number } | null): Promise<SomewhereFsSetOwnerResult>;
  uploadFromRequest(req: Request, options: SomewhereFsUploadFromRequestOptions): Promise<SomewhereFsUploadFromRequestResult>;
}
interface SomewhereRuntimeFs extends SomewhereFsView { readonly server: SomewhereFsView }

// ---- sw.search
interface SomewhereSearchManagedAddResult { path: string; version: number; chunks: number; searchable: true }
interface SomewhereSearchManagedHit {
  content: string;
  score: number;
  source: { path: string; page: number | null; locator: string; url: string };
}
interface SomewhereSearchManagedQueryResult { query: string; results: SomewhereSearchManagedHit[] }
interface SomewhereSearchIndexInfo { name: string; item_count: number; created_at: string }
interface SomewhereSearchItem { id: string; content: string; metadata?: Readonly<Record<string, unknown>> | null }
interface SomewhereSearchUpsertOptions { index: string; items: readonly SomewhereSearchItem[] }
interface SomewhereSearchUpsertResult { index: string; upserted: number; item_count: number }
type SomewhereSearchMode = 'hybrid' | 'semantic' | 'lexical';
interface SomewhereSearchQueryOptions {
  index: string;
  query: string;
  limit?: number;
  offset?: number;
  mode?: SomewhereSearchMode;
}
interface SomewhereSearchHit {
  id: string;
  score: number;
  content: string;
  metadata: SomewhereJsonObject | null;
  // snippet/signals are present in hybrid and lexical mode.
  snippet?: string;
  signals?: { semantic?: number; lexical?: number };
}
interface SomewhereSearchQueryResult {
  results: SomewhereSearchHit[];
  page: { offset: number; limit: number; total: number; has_more: boolean };
  mode: SomewhereSearchMode;
}
interface SomewhereSearchRemoveOptions { index: string; ids: readonly string[] }
interface SomewhereSearchRemoveResult { index: string; removed: number; item_count: number }
interface SomewhereRuntimeSearch {
  // Managed file search: indexes a file owned by the signed-in user.
  add(path: string): Promise<SomewhereSearchManagedAddResult>;
  createIndex(name: string): Promise<SomewhereSearchIndexInfo>;
  listIndexes(): Promise<{ indexes: SomewhereSearchIndexInfo[] }>;
  deleteIndex(name: string): Promise<{ name: string; deleted: true }>;
  upsert(options: SomewhereSearchUpsertOptions): Promise<SomewhereSearchUpsertResult>;
  // String form searches the signed-in user's managed files; object form queries a named index.
  query(query: string): Promise<SomewhereSearchManagedQueryResult>;
  query(options: SomewhereSearchQueryOptions): Promise<SomewhereSearchQueryResult>;
  remove(options: SomewhereSearchRemoveOptions): Promise<SomewhereSearchRemoveResult>;
}

// ---- sw.image
interface SomewhereImageResizeOptions {
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'scale-down' | 'crop' | 'pad';
  format?: 'auto' | 'webp' | 'avif' | 'jpeg' | 'png' | 'json' | 'baseline-jpeg';
  quality?: number;
  dpr?: number;
  gravity?: string;
  background?: string;
  blur?: number;
  sharpen?: number;
  rotate?: 0 | 90 | 180 | 270;
  trim?: string;
  metadata?: 'keep' | 'copyright' | 'none';
  anim?: boolean;
  brightness?: number;
  contrast?: number;
  gamma?: number;
  border?: string;
}
interface SomewhereRuntimeImage {
  // Synchronous: returns the transform URL string; throws on an empty source.
  resize(source: string, options?: SomewhereImageResizeOptions | null): string;
}

// ---- sw.render
type __SomewhereRenderTarget = { url: string; html?: string } | { url?: string; html: string };
type SomewhereRenderScreenshotOptions = __SomewhereRenderTarget & {
  width?: number;
  height?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  full_page?: boolean;
  // CSS selector to wait for before capture.
  wait_for?: string;
  local_storage?: Readonly<Record<string, string>>;
  cookies?: readonly { name: string; value: string }[];
  headers?: Readonly<Record<string, string>>;
};
type SomewhereRenderPdfOptions = __SomewhereRenderTarget & {
  format?: 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid';
  landscape?: boolean;
  print_background?: boolean;
  wait_for?: string;
};
interface SomewhereRenderStoredResult { storage_path: string; size_bytes: number; content_type: string }
interface SomewhereRuntimeRender {
  // With storage: writes to project files and returns its path; without: the raw image Response.
  screenshot(options: SomewhereRenderScreenshotOptions & { storage: string }): Promise<SomewhereRenderStoredResult>;
  screenshot(options: SomewhereRenderScreenshotOptions & { storage?: null }): Promise<Response>;
  screenshot(options: SomewhereRenderScreenshotOptions & { storage?: string | null }): Promise<Response | SomewhereRenderStoredResult>;
  pdf(options: SomewhereRenderPdfOptions & { storage: string }): Promise<SomewhereRenderStoredResult>;
  pdf(options: SomewhereRenderPdfOptions & { storage?: null }): Promise<Response>;
  pdf(options: SomewhereRenderPdfOptions & { storage?: string | null }): Promise<Response | SomewhereRenderStoredResult>;
}

// ---- sw.web
type SomewhereWebScrapeFormat = 'markdown' | 'html' | 'rawHtml' | 'links' | 'screenshot';
interface SomewhereWebScrapeOptions {
  formats?: readonly SomewhereWebScrapeFormat[];
  only_main?: boolean;
  // Milliseconds to let the page settle (max 30000).
  wait_for?: number;
}
interface SomewhereWebScrapeResult {
  url: string;
  title: string;
  description: string;
  language: string;
  status_code: number;
  markdown?: string;
  html?: string;
  raw_html?: string;
  links?: string[];
  // Inline data: URL when small, otherwise a short-lived scratch link.
  screenshot?: string | { scratch_url: string; expires_at: string };
  challenge_detected?: true;
}
interface SomewhereWebSearchOptions {
  count?: number;
  country?: string;
  freshness?: 'pd' | 'pw' | 'pm' | 'py';
  safesearch?: 'off' | 'moderate' | 'strict';
}
interface SomewhereWebSearchHit { url: string; title: string; description: string; age: string; source: string }
interface SomewhereWebSearchResult { query: string; results: SomewhereWebSearchHit[]; count: number }
interface SomewhereRuntimeWeb {
  scrape(url: string, options?: SomewhereWebScrapeOptions | null): Promise<SomewhereWebScrapeResult>;
  search(query: string, options?: SomewhereWebSearchOptions | null): Promise<SomewhereWebSearchResult>;
}

// ---- sw.rateLimit
interface SomewhereRateLimitResult {
  allowed: boolean;
  remaining: number;
  // Epoch seconds when the window rolls over.
  reset: number;
  limit: number;
  window_seconds: number;
  // false only in a preview check, where the limit is not counted.
  evaluated?: false;
  retry_after?: number;
  error?: string;
  message?: string;
}
interface SomewhereRuntimeRateLimit {
  check(key: string, max: number, windowSeconds: number): Promise<SomewhereRateLimitResult>;
}

// ---- sw.logs
type SomewhereLogLevel = 'debug' | 'info' | 'warn' | 'error';
type SomewhereLogSource = 'server' | 'client' | 'job' | 'cron' | 'queue' | 'system' | 'function' | 'oauth';
interface SomewhereLogsTailOptions {
  limit?: number;
  level?: SomewhereLogLevel;
  source?: SomewhereLogSource;
  search?: string;
  trace_id?: string;
  // ISO timestamp or epoch milliseconds.
  since?: string | number;
}
interface SomewhereLogEntry {
  id: string;
  level: SomewhereLogLevel;
  message: string;
  data: unknown;
  source: string | null;
  created_at: string;
  trace_id: string | null;
}
interface SomewhereTraceSpan {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  started_at: number;
  offset_ms: number;
  duration_ms: number;
  status: string;
  error_code: string | null;
  attributes: SomewhereJsonObject | null;
  depth: number;
}
interface SomewhereTraceNode extends SomewhereTraceSpan { children: SomewhereTraceNode[] }
type SomewhereTraceResult =
  | { trace_id: string; found: false; reason: string; spans: []; waterfall: [] }
  | {
      trace_id: string;
      found: true;
      project_id: string | null;
      started_at: string;
      total_duration_ms: number;
      operation_count: number;
      truncated: boolean;
      slowest_operation: { name: string; duration_ms: number; span_id: string };
      failed_operations: { name: string; span_id: string; error_code: string | null }[];
      tree: SomewhereTraceNode[];
      waterfall: SomewhereTraceSpan[];
      evidence: {
        logs: SomewhereJsonObject[];
        errors: SomewhereJsonObject[];
        deploy_failures: SomewhereJsonObject[];
        journey_events: SomewhereJsonObject[];
      };
    };
interface SomewhereRuntimeLogs {
  // Each write resolves with the platform's raw acceptance Response; throws when refused.
  debug(message: string, data?: unknown): Promise<Response>;
  info(message: string, data?: unknown): Promise<Response>;
  warn(message: string, data?: unknown): Promise<Response>;
  error(message: string, data?: unknown): Promise<Response>;
  tail(options?: SomewhereLogsTailOptions | null): Promise<SomewhereLogEntry[]>;
  // Omit the id to read the current request's trace.
  trace(traceId?: string | null): Promise<SomewhereTraceResult>;
}

// ---- sw.analytics
interface SomewhereAnalyticsTrackOptions {
  properties?: Readonly<Record<string, unknown>> | null;
  page?: string | null;
  referrer?: string | null;
  user_agent?: string | null;
}
type SomewhereAnalyticsTrackResult =
  | { recorded: true; event: string; user_id: string | null; attribution: 'app_user' | 'project' }
  | { recorded: false; reason: 'consent_pending' | 'consent_declined' | 'consent_unavailable' };
interface SomewhereAnalyticsQueryOptions {
  event?: string;
  from?: string | number;
  to?: string | number;
  group_by?: 'hour' | 'day' | 'event' | 'user';
  limit?: number;
}
interface SomewhereAnalyticsQueryResult {
  // Row columns depend on group_by (bucket/event/user_id + count, or raw events).
  rows: SomewhereJsonObject[];
  count: number;
  group_by: 'hour' | 'day' | 'event' | 'user' | null;
}
interface SomewhereRuntimeAnalytics {
  track(event: string, options?: SomewhereAnalyticsTrackOptions | null): Promise<SomewhereAnalyticsTrackResult>;
  query(options?: SomewhereAnalyticsQueryOptions | null): Promise<SomewhereAnalyticsQueryResult>;
}

interface SomewhereRuntimeContext {
  readonly fs: SomewhereRuntimeFs;
  readonly search: SomewhereRuntimeSearch;
  readonly image: SomewhereRuntimeImage;
  readonly render: SomewhereRuntimeRender;
  readonly web: SomewhereRuntimeWeb;
  /** @deprecated The global fetch is the same policy-checked outbound fetch. */
  readonly fetch: typeof fetch;
  readonly rateLimit: SomewhereRuntimeRateLimit;
  readonly logs: SomewhereRuntimeLogs;
  readonly analytics: SomewhereRuntimeAnalytics;
}
// ---- sw.ai ----
type SomewhereAiProvider = 'anthropic' | 'openai' | 'xai' | 'workers-ai' | 'deepseek' | 'deepinfra';
interface SomewhereAiInputBlock { type: string; [key: string]: unknown }
/** Native Anthropic image input. Encode file bytes without a data: URL prefix. */
interface SomewhereAiImageInputBlock extends SomewhereAiInputBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}
/** Native Anthropic PDF input for one-shot extraction. */
interface SomewhereAiDocumentInputBlock extends SomewhereAiInputBlock {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
}
interface SomewhereAiMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | readonly SomewhereAiInputBlock[];
}
// Normalized content block: text, tool_use (id/name/input) or a provider-native block.
interface SomewhereAiContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: SomewhereJsonObject;
  [key: string]: unknown;
}
interface SomewhereAiToolDefinition {
  name: string;
  description?: string;
  input_schema: SomewhereJsonObject;
  type?: 'custom';
  cache_control?: SomewhereJsonObject;
}
type SomewhereAiSettledCost = { total_cents: number; total: string; status?: never };
type SomewhereAiCost = SomewhereAiSettledCost | { status: 'pending'; total_cents: null; total: null };
type SomewhereAiCompaction = 'truncate' | 'summarize'
  | { mode: 'truncate' | 'summarize'; provider?: SomewhereAiProvider; model?: string };
interface SomewhereAiChatOptions {
  messages: readonly SomewhereAiMessage[];
  provider?: SomewhereAiProvider;
  model?: string;
  system?: string;
  max_tokens?: number;
  tools?: readonly SomewhereAiToolDefinition[];
  tool_choice?: string | SomewhereJsonObject;
  response_schema?: SomewhereJsonObject;
  // true returns the raw SSE body (anthropic only; not with conversation_id/response_schema).
  stream?: boolean;
  conversation_id?: string;
  compaction?: SomewhereAiCompaction;
  history_max_messages?: number;
  history_max_tokens?: number;
  idempotency_key?: string;
  service_tier?: 'standard' | 'flex';
}
interface SomewhereAiChatResult {
  content: SomewhereAiContentBlock[];
  text: string;
  stop_reason: string | null;
  model: string | null;
  provider: string;
  usage: { input_tokens: number | null; output_tokens: number | null };
  parsed?: SomewhereJsonObject | null;
  parse_error?: string | null;
  fallback_used?: boolean;
  fallback_provider?: string | null;
  service_tier?: 'standard' | 'flex' | null;
  // Non-enumerable: readable directly, dropped by spread / JSON.stringify.
  cost: SomewhereAiCost;
  conversation_id?: string;
  conversation_subject_type?: string | null;
  conversation_subject_id?: string | null;
  conversation_truncated?: boolean;
  conversation_summarized?: boolean;
  conversation_turn_id?: string;
  conversation_turn_state?: string;
}
interface __SomewhereAiChatFn {
  (options: SomewhereAiChatOptions & { stream: true }): Promise<ReadableStream<Uint8Array>>;
  (options: SomewhereAiChatOptions & { stream?: false }): Promise<SomewhereAiChatResult>;
  /** `stream` typed as plain boolean, e.g. `const o = { messages, stream: false }` (false widens to boolean): narrow the result with `instanceof ReadableStream`, or write `stream: false as const`. */
  (options: SomewhereAiChatOptions): Promise<SomewhereAiChatResult | ReadableStream<Uint8Array>>;
}
interface SomewhereAiConversationSummary {
  id: string;
  client_conversation_id: string | null;
  subject_type: string;
  subject_id: string;
  created_at: string;
  updated_at: string;
  summary_updated_at: string | null;
  message_count: number;
  summarized_message_count: number;
}
interface SomewhereAiConversationMessage {
  id: number;
  role: string;
  content: string | SomewhereAiContentBlock[];
  token_count: number | null;
  summarized_at: string | null;
  created_at: string;
}
interface SomewhereAiConversationTurn {
  id: string;
  state: string;
  stored_state: string;
  provider: string | null;
  model: string | null;
  usage: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}
interface SomewhereAiConversation {
  id: string;
  client_conversation_id: string | null;
  subject_type: string;
  subject_id: string;
  summary: string | null;
  summary_updated_at: string | null;
  created_at: string;
  updated_at: string;
  messages: SomewhereAiConversationMessage[];
  turns: SomewhereAiConversationTurn[];
}
interface SomewhereAiConversationFork {
  forked: true;
  source_conversation_id: string;
  new_conversation_id: string;
  message_count: number;
  subject_type: string;
  subject_id: string;
}
interface SomewhereAiConversationsAccessor {
  list(options?: { limit?: number }): Promise<{ conversations: SomewhereAiConversationSummary[] }>;
  // include: 'summarized' also returns messages already folded into the summary.
  get(id: string, options?: { include?: string }): Promise<SomewhereAiConversation>;
  delete(id: string): Promise<{ deleted: boolean; conversation_id: string }>;
  fork(sourceId: string, newId: string, options?: { upToMessageId?: number }): Promise<SomewhereAiConversationFork>;
}
interface SomewhereAiConversations extends SomewhereAiConversationsAccessor {
  // Developer capability: another end-user's conversations, without a signed-in request.
  forUser(userId: string): SomewhereAiConversationsAccessor;
}
interface SomewhereAiScoped {
  readonly chat: __SomewhereAiChatFn;
  readonly complete: __SomewhereAiChatFn;
  chatWithTools(options: SomewhereAiChatWithToolsOptions): Promise<SomewhereAgentRunResult>;
  readonly conversations: SomewhereAiConversationsAccessor;
}
interface SomewhereAiUserMemoryCompactOptions {
  conversation_id?: string;
  history?: string;
  windowMessages?: number;
  provider?: SomewhereAiProvider;
  model?: string;
  maxTokens?: number;
}
// Subject is the request's verified user; every call requires a signed-in user.
interface SomewhereAiUserMemory {
  get(): Promise<SomewhereJsonObject>;
  update(patch: SomewhereJsonObject): Promise<SomewhereJsonObject>;
  clear(): Promise<{ cleared: true }>;
  compact(schema: SomewhereJsonObject, options?: SomewhereAiUserMemoryCompactOptions): Promise<SomewhereJsonObject>;
}
type SomewhereAiTranscribeOptions = {
  model?: string;
  /** Spoken language hint for the default transcription model, e.g. 'en'. */
  language?: string;
  /** Names, vocabulary or context for the default transcription model. */
  prompt?: string;
} & (
  | { audio: string; audio_url?: string }
  | { audio?: string; audio_url: string }
);
interface SomewhereAiTranscribeResult {
  text: string;
  duration_seconds: number;
  words: { word: string; start: number; end: number }[];
  model: string;
  cost: SomewhereAiSettledCost;
}
interface __SomewhereAiStoredFile {
  storage_path: string;
  size_bytes: number;
  content_type: string;
  model: string;
  owner_subject_type: 'app_user' | 'project_owner';
  owner_subject_id: string;
  cost: SomewhereAiSettledCost;
}
interface SomewhereAiTtsOptions {
  text: string;
  model?: string;
  voice?: string;
  lang?: string;
  // Set: the audio is saved to this file path and a JSON envelope returns; unset: raw audio Response.
  storage?: string;
}
interface SomewhereAiTtsStored extends __SomewhereAiStoredFile { duration_seconds_estimate: number }
interface SomewhereAiGenerateImageOptions {
  prompt: string;
  model?: string;
  // Accepted and ignored: the model selects the provider.
  provider?: SomewhereAiProvider;
  width?: number;
  height?: number;
  steps?: number;
  // gpt-image-2.5-flare only; refused on other models.
  quality?: 'low' | 'medium' | 'high';
  background?: 'auto' | 'opaque' | 'transparent';
  storage?: string;
}
interface SomewhereAiGenerateImageStored extends __SomewhereAiStoredFile {
  width: number; height: number; steps: number;
  quality?: 'low' | 'medium' | 'high';
  background?: 'auto' | 'opaque' | 'transparent';
}
interface SomewhereAiRemoveBackgroundOptions { image_url: string; model?: string; storage?: string }
type SomewhereAiEmbeddingsOptions = {
  model?: string;
  dimensions?: number;
  // Accepted and ignored: the model selects the provider.
  provider?: SomewhereAiProvider;
} & (
  | { text: string | readonly string[]; input?: never }
  | { input: string | readonly string[]; text?: never }
);
interface SomewhereAiEmbeddingsResult {
  model: string;
  provider: string;
  dimensions: number;
  count: number;
  embeddings: number[][];
  usage: { input_tokens: number };
  cost: SomewhereAiSettledCost;
}
interface SomewhereAiModerationResult {
  flagged: boolean;
  categories: string[];
  scores: Record<string, number>;
  model: string;
  provider: string;
}
interface SomewhereAiCatalogEntry {
  feature: 'transcribe' | 'tts' | 'generate_image' | 'remove_background' | 'embed' | 'complete';
  model: string;
  provider: string;
  label: string;
  pricing: string;
  at_cost: boolean;
  free: boolean;
  note?: string;
  alias_for?: string;
  voices?: Record<string, readonly string[]>;
}
interface SomewhereAiCatalog {
  your_tier: string;
  rate_limits: SomewhereJsonObject;
  rate_limits_by_tier: SomewhereJsonObject;
  free_complete_default: SomewhereAiCatalogEntry & { limits: SomewhereJsonObject };
  models: SomewhereAiCatalogEntry[];
}
interface SomewhereRuntimeAi {
  readonly chat: __SomewhereAiChatFn;
  readonly complete: __SomewhereAiChatFn;
  // Runs the sw.agent loop; executeTools is required and maxIterations defaults to 5.
  chatWithTools(options: SomewhereAiChatWithToolsOptions): Promise<SomewhereAgentRunResult>;
  readonly conversations: SomewhereAiConversations;
  readonly userMemory: SomewhereAiUserMemory;
  scoped(subjectId: string, subjectType?: string): SomewhereAiScoped;
  forUser(userId: string): SomewhereAiScoped;
  transcribe(options: SomewhereAiTranscribeOptions): Promise<SomewhereAiTranscribeResult>;
  tts(options: SomewhereAiTtsOptions & { storage: string }): Promise<SomewhereAiTtsStored>;
  tts(options: SomewhereAiTtsOptions & { storage?: undefined }): Promise<Response>;
  tts(options: SomewhereAiTtsOptions): Promise<SomewhereAiTtsStored | Response>;
  generateImage(options: SomewhereAiGenerateImageOptions & { storage: string }): Promise<SomewhereAiGenerateImageStored>;
  generateImage(options: SomewhereAiGenerateImageOptions & { storage?: undefined }): Promise<Response>;
  generateImage(options: SomewhereAiGenerateImageOptions): Promise<SomewhereAiGenerateImageStored | Response>;
  // Managed background removal is retired: every call rejects with VALIDATION_ERROR.
  removeBackground(options: SomewhereAiRemoveBackgroundOptions): Promise<never>;
  embeddings(options: SomewhereAiEmbeddingsOptions): Promise<SomewhereAiEmbeddingsResult>;
  moderate(text: string): Promise<SomewhereAiModerationResult>;
  catalog(): Promise<SomewhereAiCatalog>;
}

// ---- sw.agent ----
interface SomewhereAgentToolContext { agentId: string | null; turn: number; toolCallId: string }
type SomewhereAgentToolExecute = (input: SomewhereJsonObject, context: SomewhereAgentToolContext) => unknown;
interface SomewhereAgentKeyedTool {
  description?: string;
  inputSchema?: SomewhereJsonObject;
  input_schema?: SomewhereJsonObject;
  // Required unless options.executeTools is supplied.
  execute?: SomewhereAgentToolExecute;
}
interface SomewhereAgentTool extends SomewhereAgentKeyedTool { name: string }
interface SomewhereAgentToolCall { id: string; name: string; input: SomewhereJsonObject }
interface SomewhereAgentToolResultRow { tool_use_id: string; content: unknown; is_error?: boolean }
interface SomewhereAgentToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: true }
interface SomewhereAgentStep {
  step_number: number;
  turn: number;
  provider: string | null;
  model: string | null;
  content: SomewhereAiContentBlock[];
  text: string;
  output: string | null;
  stop_reason: string | null;
  tool_calls: { id: string; name: string; input: SomewhereJsonObject; is_error: boolean }[];
  tool_results: SomewhereAgentToolResultBlock[];
  usage: { input_tokens: number | null; output_tokens: number | null } | null;
  started_at: number;
  duration_ms: number;
  completion_reason: string;
  on_step?: unknown;
  // Non-enumerable; null while the step's cost is pending.
  readonly cost_cents: number | null;
}
interface SomewhereAgentPrepareStepContext {
  stepNumber: number;
  steps: SomewhereAgentStep[];
  messages: SomewhereAiMessage[];
  provider: SomewhereAiProvider | undefined;
  model: string | undefined;
  system: string | undefined;
  tools: SomewhereAiToolDefinition[] | undefined;
  toolChoice: string | SomewhereJsonObject | undefined;
  maxTokens: number | undefined;
}
interface SomewhereAgentPrepareStepOverride {
  messages?: readonly SomewhereAiMessage[];
  provider?: SomewhereAiProvider;
  model?: string;
  system?: string;
  tools?: readonly SomewhereAiToolDefinition[];
  toolChoice?: string | SomewhereJsonObject;
  maxTokens?: number;
}
interface SomewhereAgentStepEvent { step: SomewhereAgentStep; steps: SomewhereAgentStep[] }
interface SomewhereAgentOnStepEvent {
  agentId: string | null;
  turn: number;
  maxTurns: number;
  output: string | null;
  toolCalls: { id: string; name: string; is_error: boolean }[];
  done: boolean;
  stopReason: string | null;
}
type __SomewhereMaybePromise<T> = T | Promise<T>;
interface SomewhereAgentOptions extends Omit<SomewhereAiChatOptions, 'messages' | 'tools' | 'stream'> {
  // One input source is required: a non-empty messages array, prompt, or input.
  messages?: readonly SomewhereAiMessage[];
  prompt?: string;
  input?: string;
  systemPrompt?: string;
  serviceTier?: 'standard' | 'flex';
  maxTokens?: number;
  tools?: readonly SomewhereAgentTool[] | Readonly<Record<string, SomewhereAgentKeyedTool>>;
  executeTools?: (calls: SomewhereAgentToolCall[]) => __SomewhereMaybePromise<readonly SomewhereAgentToolResultRow[]>;
  // Integer 1-20; first defined of maxSteps, maxIterations, maxTurns wins (default 8).
  maxSteps?: number;
  maxIterations?: number;
  maxTurns?: number;
  maxSpendCents?: number;
  prepareStep?: (context: SomewhereAgentPrepareStepContext) => __SomewhereMaybePromise<SomewhereAgentPrepareStepOverride | null | undefined | void>;
  onStepFinish?: (event: SomewhereAgentStepEvent) => unknown;
  stopWhen?: (event: SomewhereAgentStepEvent) => __SomewhereMaybePromise<boolean | string | null | undefined>;
  onStep?: (event: SomewhereAgentOnStepEvent) => unknown;
}
interface SomewhereAiChatWithToolsOptions extends SomewhereAgentOptions {
  executeTools: (calls: SomewhereAgentToolCall[]) => __SomewhereMaybePromise<readonly SomewhereAgentToolResultRow[]>;
}
interface SomewhereAgentDurableOptions extends SomewhereAgentOptions { model: string }
interface SomewhereAgentRunResult extends Omit<SomewhereAiChatResult, 'cost'> {
  iterations: number;
  tool_calls_made: number;
  total_input_tokens: number;
  total_output_tokens: number;
  completion_reason: string;
  // Non-enumerable: readable directly, dropped by spread / JSON.stringify.
  readonly steps: SomewhereAgentStep[];
  readonly total_cost_cents: number | null;
}
// Returned instead when this invocation is the platform's signed step callback; return it from the handler.
interface SomewhereAgentStepCheckpoint {
  __sw_agent_turn: true;
  state: SomewhereJsonObject;
  done: boolean;
  // Present only when the run stopped at its budget and the platform's signed callback reads terminal budget
  // envelopes; the platform then records the run as failed with this code. Otherwise the budget stop throws.
  error?: { code: 'AI_SPEND_CAP_EXCEEDED' | 'AI_COST_PENDING'; message: string };
  agent_id?: never;
  status?: never;
  max_steps?: never;
  max_turns?: never;
}
type SomewhereAgentStartResult = SomewhereAgentStepCheckpoint
  | { agent_id: string; status: string; max_steps: number; __sw_agent_turn?: never; state?: never; done?: never };
type SomewhereAgentLegacyStartResult = SomewhereAgentStepCheckpoint
  | { agent_id: string; status: string; max_turns: number; __sw_agent_turn?: never; state?: never; done?: never };
interface SomewhereAgentStatus {
  agent_id: string;
  job_id: string;
  project_id: string;
  handler: string;
  status: string;
  progress: number;
  progress_message: string | null;
  payload: unknown;
  result: unknown;
  error: string | null;
  error_code: string | null;
  webhook_url: string | null;
  webhook_delivered: boolean;
  timeout_seconds: number;
  attempts: unknown[];
  priority: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  ownership_status: 'app_user' | 'project_owner';
  owner_subject_id: string | null;
  cron_id: string | null;
  cron_scheduled_at: string | null;
  trigger: string | null;
  recovery: { dispatch_state: string; workflow_state: string | null; recovery_error: string | null; observed_at: number | null } | null;
}
interface SomewhereAgentCancelResult {
  agent_id: string;
  job_id: string;
  status: 'cancelled';
  ownership_status: 'app_user' | 'project_owner';
  owner_subject_id: string | null;
}
interface SomewhereRuntimeAgent {
  // Durable compatibility form: same as start() but reports max_turns.
  (options: SomewhereAgentDurableOptions): Promise<SomewhereAgentLegacyStartResult>;
  run(options: SomewhereAgentOptions): Promise<SomewhereAgentRunResult>;
  start(options: SomewhereAgentDurableOptions): Promise<SomewhereAgentStartResult>;
  status(agentId: string): Promise<SomewhereAgentStatus>;
  cancel(agentId: string): Promise<SomewhereAgentCancelResult>;
}

interface SomewhereRuntimeContext { readonly ai: SomewhereRuntimeAi; readonly agent: SomewhereRuntimeAgent }
// ── sw.email / sw.contacts ─────────────────────────────────────────
type SomewhereEmailStatus =
  | 'claimed' | 'pending' | 'sent' | 'delivered' | 'opened' | 'clicked'
  | 'bounced' | 'complained' | 'suppressed' | 'preference_blocked'
  | 'delivery_unknown' | 'failed' | 'captured';
type SomewhereEmailTopic = 'project-updates' | 'milestones' | 'announcements' | 'founder-notes';
// At least one of html / text is required.
type __SomewhereEmailBody = { html: string; text?: string } | { text: string; html?: string };
type SomewhereEmailSendOptions = {
  // One recipient address.
  to: string;
  subject: string;
  // Omit for the platform-managed sender; otherwise a verified sender domain on this project.
  from?: string;
  reply_to?: string;
  // 'marketing' requires a topic.
  category?: 'transactional' | 'marketing';
  subtype?: string;
  topic?: SomewhereEmailTopic;
  template_key?: string;
  campaign_key?: string;
  journey_key?: string;
  step_key?: string;
  idempotency_key?: string;
  in_reply_to?: string;
  references?: readonly string[];
  app_user_id?: string;
} & __SomewhereEmailBody;
interface SomewhereEmailSendResult {
  id: string;
  message_id: string;
  // Absent on a captured (test inbox) send.
  tracking_id?: string;
  // A new send is 'sent' | 'pending' | 'captured'; a duplicate replays the stored state.
  status: SomewhereEmailStatus;
  duplicate?: true;
  sender?: { from: string; mode: 'platform_managed'; note: string };
  test_inbox?: { address: string; delivered: false };
}
interface SomewhereEmailEventCounts {
  sent: number; delivered: number; opened: number; clicked: number;
  bounced: number; complained: number; delivery_delayed: number; total: number;
}
interface SomewhereEmailHistoryMessage {
  id: string;
  tracking_id: string;
  provider_message_id: string;
  contact_id: string | null;
  category: 'transactional' | 'marketing';
  subtype: string | null;
  topic: string | null;
  template_key: string | null;
  campaign_key: string | null;
  journey_key: string | null;
  step_key: string | null;
  idempotency_key: string | null;
  message_id_header: string | null;
  from_address: string;
  to_address: string;
  subject: string;
  status: string;
  created_at: number;
  sent_at: number;
  latest_at: number;
  event_counts: SomewhereEmailEventCounts;
  env_slot: string;
}
interface SomewhereEmailStatusResult {
  // The stored message row (id, status, recipients, ...).
  message: SomewhereJsonObject;
  events: SomewhereJsonObject[];
}
interface SomewhereEmailSuppression {
  address: string;
  suppressed: boolean;
  status: 'bounced' | 'complained' | null;
  last_at: string | null;
  occurrences: number;
}
interface SomewhereEmailBounce {
  address: string;
  last_status: 'bounced' | 'complained';
  last_at: string;
  occurrences: number;
}
interface SomewhereEmailTestInboxMessage {
  id: string;
  to: string;
  subject: string;
  html: string | null;
  text: string | null;
  magic_link: string | null;
  created_at: string;
}
interface SomewhereRuntimeEmail {
  send(message: SomewhereEmailSendOptions): Promise<SomewhereEmailSendResult>;
  history(options?: { limit?: number; offset?: number } | null): Promise<{ messages: SomewhereEmailHistoryMessage[] }>;
  status(id: string): Promise<SomewhereEmailStatusResult>;
  checkSuppression(address: string): Promise<SomewhereEmailSuppression>;
  bounces(options?: { days?: number; limit?: number } | null): Promise<{ bounces: SomewhereEmailBounce[]; window_days: number; limit: number }>;
  // Reads only this project's <anything>@<subdomain>.test.somewhere.site test inbox.
  inbox(address: string, options?: { limit?: number } | null): Promise<{ address: string; messages: SomewhereEmailTestInboxMessage[]; limit: number }>;
}
interface SomewhereEmailContactProperties {
  email_topics?: Partial<Record<SomewhereEmailTopic, boolean>>;
  tags?: readonly string[];
  unsubscribed?: boolean;
  app_user_id?: string;
  source?: string;
  // Reserved: the platform binds this; sending it is a VALIDATION_ERROR.
  platform_user_id?: never;
  [key: string]: unknown;
}
interface SomewhereEmailContact {
  id: string;
  display_name: string | null;
  properties: SomewhereEmailContactProperties;
  email: string;
  normalized_email: string;
  is_primary: boolean;
  created_at: number;
  updated_at: number;
}
interface SomewhereRuntimeContacts {
  upsert(contact: { email: string; display_name?: string | null; properties?: SomewhereEmailContactProperties; id?: string }): Promise<{ contact: SomewhereEmailContact }>;
  get(idOrEmail: string): Promise<{ contact: SomewhereEmailContact }>;
  list(options?: { limit?: number; offset?: number } | null): Promise<{ contacts: SomewhereEmailContact[] }>;
}

// ── sw.inbox ───────────────────────────────────────────────────────
type SomewhereInboxOwnershipStatus = 'app_user' | 'project_owner' | 'legacy_project';
// At least one of body / text / html is required (body is an alias of text).
type __SomewhereInboxBody =
  | { body: string; text?: string; html?: string }
  | { text: string; body?: string; html?: string }
  | { html: string; body?: string; text?: string };
interface SomewhereInboxAddressCreateOptions {
  address: string;
  label?: string;
  webhook_url?: string;
  forward_to?: string;
}
interface SomewhereInboxAddressCreated {
  id: string;
  project_id: string;
  address: string;
  label: string | null;
  kind: 'admin' | 'app';
  ownership_status: 'app_user' | 'project_owner';
  webhook_url: string | null;
  // Returned once, only when webhook_url was set.
  webhook_secret: string | null;
  forward?: SomewhereJsonObject;
  created_at: string;
}
interface SomewhereInboxAddress {
  id: string;
  address: string;
  label: string | null;
  created_at: string;
  webhook_url: string | null;
  forward_to: string | null;
  forward_status: 'active' | 'pending_verification' | null;
  ownership_status: SomewhereInboxOwnershipStatus;
}
interface SomewhereInboxListOptions {
  address_id?: string;
  limit?: number;
  unread?: boolean;
  q?: string;
  include_spam?: boolean;
}
interface SomewhereInboxMessageSummary {
  id: string;
  address_id: string;
  mail_from: string;
  mail_to: string;
  subject: string | null;
  text_preview: string | null;
  has_html: boolean;
  attachment_count: number;
  size_bytes: number;
  read_at: string | null;
  received_at: string;
  thread_root: string | null;
  spf_result: string | null;
  dkim_result: string | null;
  dmarc_result: string | null;
  spam_suspect: boolean;
  ownership_status: SomewhereInboxOwnershipStatus;
}
interface SomewhereInboxAttachmentMeta {
  filename: string | null;
  content_type: string;
  size_bytes: number;
  r2_key: string;
}
interface SomewhereInboxMessage extends SomewhereInboxMessageSummary {
  project_id: string;
  r2_key: string;
  message_id_header: string | null;
  in_reply_to_header: string | null;
  references_header: string | null;
  attachments: SomewhereInboxAttachmentMeta[];
  raw_url: string;
  // Present only with include_html: true.
  html_preview?: string | null;
}
interface SomewhereInboxSendPending {
  id: string;
  message_id: string;
  status: 'pending';
  code: 'EMAIL_SEND_PENDING';
  duplicate?: true;
}
interface __SomewhereInboxSentBase {
  id: string;
  from: string;
  to: string;
  subject: string;
  thread_root: string;
  status?: never;
  duplicate?: true;
  test_inbox?: { address: string; delivered: false };
}
interface SomewhereInboxSent extends __SomewhereInboxSentBase { message_id: string }
interface SomewhereInboxReplySent extends __SomewhereInboxSentBase { inbox_message_id: string }
interface SomewhereInboxThreadSummary {
  thread_root: string;
  last_at: string;
  first_at: string;
  message_count: number;
  unread_count: number;
  last_subject: string | null;
  last_counterparty: string;
  last_direction: 'in' | 'out';
  ownership_status: SomewhereInboxOwnershipStatus;
}
type SomewhereInboxThreadMessage =
  | {
    direction: 'in'; id: string; address_id: string; mail_from: string; mail_to: string;
    subject: string | null; text_preview: string | null; has_html: boolean;
    attachment_count: number; read_at: string | null; received_at: string;
    spf_result: string | null; dkim_result: string | null; dmarc_result: string | null;
    spam_suspect: boolean; message_id: string | null; ownership_status: SomewhereInboxOwnershipStatus;
  }
  | {
    direction: 'out'; id: string; to: string; from: string; subject: string | null;
    body: string | null; text_preview: string | null; sent_at: string; is_reply: boolean;
    message_id: string | null; inbox_message_id: string | null; ownership_status: SomewhereInboxOwnershipStatus;
  };
interface SomewhereInboxRule {
  id: string;
  address_id: string | null;
  pattern: string;
  action: 'allow' | 'deny';
  created_at: string;
}
interface SomewhereInboxRules {
  list(options?: { address_id?: string } | null): Promise<{ rules: SomewhereInboxRule[] }>;
  // Omit address_id for a project-wide rule (sw.inbox.project only).
  create(rule: { pattern: string; action: 'allow' | 'deny'; address_id?: string }): Promise<SomewhereInboxRule & { project_id: string }>;
  delete(id: string): Promise<{ id: string; deleted: true }>;
}
interface SomewhereInboxClient {
  listAddresses(): Promise<{ addresses: SomewhereInboxAddress[] }>;
  createAddress(options: SomewhereInboxAddressCreateOptions): Promise<SomewhereInboxAddressCreated>;
  listAppAddresses(): Promise<{ addresses: SomewhereInboxAddress[] }>;
  deleteAddress(id: string): Promise<{ id: string; deleted: true }>;
  list(options?: SomewhereInboxListOptions | null): Promise<{ messages: SomewhereInboxMessageSummary[]; count: number }>;
  get(id: string, options?: { include_html?: boolean } | null): Promise<SomewhereInboxMessage>;
  // Raw RFC-822 bytes; the Response carries X-Somewhere-Ownership-Status.
  raw(id: string): Promise<Response>;
  attachment(id: string, index: number): Promise<Response>;
  markRead(id: string, read?: boolean): Promise<{ id: string; read: boolean; ownership_status: SomewhereInboxOwnershipStatus; read_at: string | null }>;
  delete(id: string): Promise<{ id: string; deleted: true }>;
  reply(id: string, reply: { subject?: string; idempotency_key?: string } & __SomewhereInboxBody): Promise<SomewhereInboxReplySent | SomewhereInboxSendPending>;
  send(addressId: string, message: { to: string; subject: string; idempotency_key?: string } & __SomewhereInboxBody): Promise<SomewhereInboxSent | SomewhereInboxSendPending>;
  threads(options?: { address_id?: string; limit?: number; include_spam?: boolean } | null): Promise<{ threads: SomewhereInboxThreadSummary[] }>;
  thread(root: string): Promise<{ thread_root: string; messages: SomewhereInboxThreadMessage[] }>;
  readonly rules: SomewhereInboxRules;
}
interface SomewhereInboxGrant {
  collaborator_user_id: string;
  role: 'viewer' | 'editor';
  granted_by: string;
  created_at: string;
}
// Trusted project-scope inbox: createAddress makes admin mailboxes; owner-only grants/migration.
interface SomewhereRuntimeProjectInbox extends SomewhereInboxClient {
  assignLegacyOwner(addressId: string, appUserId: string): Promise<{ id: string; ownership_status: 'app_user'; migrated_message_count: number; migration_id: string }>;
  readonly grants: {
    list(addressId: string): Promise<{ address_id: string; ownership_status: SomewhereInboxOwnershipStatus; grants: SomewhereInboxGrant[] }>;
    set(addressId: string, collaboratorUserId: string, role: 'viewer' | 'editor'): Promise<{ address_id: string; collaborator_user_id: string; role: 'viewer' | 'editor'; ownership_status: 'app_user'; created_at: string }>;
    delete(addressId: string, collaboratorUserId: string): Promise<{ address_id: string; collaborator_user_id: string; deleted: true }>;
  };
}
// Scoped to the request's verified app user; createAddress makes app mailboxes.
interface SomewhereRuntimeInbox extends SomewhereInboxClient {
  readonly project: SomewhereRuntimeProjectInbox;
}

// ── sw.notifications ───────────────────────────────────────────────
type SomewhereNotificationsChannel = 'bell' | 'push' | 'email';
interface SomewhereNotificationsSendOptions {
  title?: string;
  body?: string;
  url?: string | null;
  // Recipient address; required for the email channel.
  email?: string;
  from?: string;
  // Default ['bell', 'push'].
  channels?: readonly SomewhereNotificationsChannel[];
}
interface SomewhereNotificationsChannelFailure { ok: false; error: string; code?: string }
interface SomewhereNotificationsSendResult {
  bell?: { ok: true; id: string } | SomewhereNotificationsChannelFailure;
  push?: ({ ok: true } & SomewherePushSendResult) | SomewhereNotificationsChannelFailure;
  email?: ({ ok: true } & SomewhereEmailSendResult) | SomewhereNotificationsChannelFailure;
}
interface SomewhereNotification {
  id: string;
  title: string | null;
  body: string | null;
  url: string | null;
  // 0 or 1.
  read: number;
  created_at: number;
}
// list / unreadCount / markRead / markAllRead act on the request's verified user (AUTH_REQUIRED otherwise).
interface SomewhereRuntimeNotifications {
  send(userId: string, options: SomewhereNotificationsSendOptions): Promise<SomewhereNotificationsSendResult>;
  list(options?: { limit?: number; unread_only?: boolean } | null): Promise<{ notifications: SomewhereNotification[]; count: number }>;
  unreadCount(): Promise<number>;
  markRead(notificationId: string): Promise<{ ok: true; changes: number } | { ok: false; error: string }>;
  markAllRead(): Promise<{ ok: true; changes: number }>;
}

// ── sw.push ────────────────────────────────────────────────────────
interface SomewherePushSendOptions {
  // Required: a string or any JSON-serializable value.
  payload: string | number | boolean | object;
  // Exactly one target; a missing, null or empty one is refused.
  user_id?: string;
  userId?: string;
  endpoint?: string;
  subscription_id?: string;
  subscriptionId?: string;
  // 'developer': devices registered with developer credentials. 'all': every device.
  audience?: 'developer' | 'all';
  ttl?: number;
}
type SomewherePushPlatform = 'web' | 'test';
type SomewherePushDeliveryOutcome = 'sent' | 'failed' | 'gone' | 'captured';
interface SomewherePushDeviceResult {
  delivery_id: string;
  subscription_id: string;
  user_id: string | null;
  platform: SomewherePushPlatform;
  device_label: string | null;
  endpoint_host: string | null;
  outcome: SomewherePushDeliveryOutcome;
  http_status: number | null;
  error: string | null;
}
interface SomewherePushSendResult {
  sent: number; failed: number; gone: number; captured: number; recipients: number;
  // false: the notifications went out but their history was not recorded.
  history_recorded: boolean;
  devices: SomewherePushDeviceResult[];
}
// The object PushManager.subscribe() returns, or its toJSON().
interface SomewherePushBrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
interface SomewherePushSubscribeResult {
  id: string; platform: SomewherePushPlatform; owner: 'app_user' | 'developer';
  created: boolean; reassigned?: boolean;
}
interface SomewherePushDevice {
  // 'legacy': stored before owners were verified; no send reaches it until it re-registers.
  id: string; user_id: string | null; owner: 'app_user' | 'developer' | 'legacy';
  platform: SomewherePushPlatform; device_label: string | null; endpoint_host: string | null;
  created_at: string; updated_at: string | null;
}
interface SomewherePushDelivery {
  id: string; subscription_id: string; user_id: string | null; platform: SomewherePushPlatform;
  device_label: string | null; endpoint_host: string | null; outcome: SomewherePushDeliveryOutcome;
  http_status: number | null; error: string | null; title: string | null; url: string | null;
  // Present on test-inbox deliveries only.
  payload?: unknown;
  created_at: string;
}
interface SomewherePushHistoryOptions {
  user_id?: string;
  userId?: string;
  subscription_id?: string;
  subscriptionId?: string;
  limit?: number;
}
interface SomewhereRuntimePush {
  vapidPublicKey(): Promise<{ vapid_public_key: string }>;
  // Registers a device for the signed-in user of this request (AUTH_REQUIRED without one).
  subscribe(
    subscription: SomewherePushBrowserSubscription | { toJSON(): SomewherePushBrowserSubscription } | { test: true },
    options?: { label?: string },
  ): Promise<SomewherePushSubscribeResult>;
  unsubscribe(target: string | { endpoint: string } | { test: true }): Promise<{ deleted: boolean }>;
  send(options: SomewherePushSendOptions): Promise<SomewherePushSendResult>;
  subscriptions(options?: { user_id?: string; userId?: string; limit?: number }): Promise<{ subscriptions: SomewherePushDevice[] }>;
  deliveries(options?: SomewherePushHistoryOptions): Promise<{ deliveries: SomewherePushDelivery[] }>;
}

// The push browser helper (tsk_80c0ed92). The compiler maps this specifier to
// the same-origin /__sw/push/client.js the project origin serves.
declare module 'somewhere:push' {
  export interface PushDeviceResult {
    endpoint?: string; id: string; platform: 'web' | 'test'; owner: 'app_user' | 'developer';
    created: boolean; reassigned?: boolean;
  }
  export interface PushStatus { supported: boolean; permission: NotificationPermission | 'unsupported'; subscribed: boolean; endpoint: string | null }
  export interface PushMessage { type: 'push' | 'click'; payload: unknown }
  export function enablePush(options?: { test?: boolean; label?: string }): Promise<PushDeviceResult>;
  export function disablePush(options?: { test?: boolean }): Promise<{ deleted: boolean }>;
  export function pushStatus(): Promise<PushStatus>;
  export function listenToPush(handler: (message: PushMessage) => void): () => void;
}

// ── sw.queue / sw.jobs ─────────────────────────────────────────────
interface SomewhereQueuePushOptions {
  // A project-relative /api path or an https:// URL.
  handler: string;
  payload?: unknown;
  // Max 43200 (12 hours).
  delay_seconds?: number;
  idempotency_key?: string;
  queue_name?: string;
}
interface SomewhereRuntimeQueue {
  push(options: SomewhereQueuePushOptions): Promise<{ message_id: string; status: 'pending' | 'queued'; deduped?: true }>;
  // Same check as sw.jobs.verifyInvocation.
  verifyInvocation(req: Request): Promise<boolean>;
}
interface SomewhereJobsCreateOptions {
  handler: string;
  payload?: unknown;
  webhook_url?: string;
  timeout_seconds?: number;
  priority?: 'normal' | 'low';
  // Generated per call when omitted.
  idempotency_key?: string;
  // Earliest start: an ISO-8601 time with an explicit offset, e.g. '2026-10-05T09:00:00Z'. Must be in the future.
  run_at?: string;
  agent?: { messages: readonly unknown[]; max_steps?: number; max_turns?: number; deployment_version?: string };
  // Row-bound job: acts for the signed-in user on ONE row of a job binding declared in db/schema.ts, with only that
  // binding's operations, until its deadline. id is the row's id(): a whole number, or a string for uuid ids.
  // Created only from that user's own request (not from another job); not combined with agent.
  row?: { binding: string; id: number | string };
}
interface SomewhereJobsRecovery {
  dispatch_state: string;
  workflow_state?: string | null;
  recovery_error: string | null;
  observed_at?: number | null;
}
interface SomewhereJobsCreateResult {
  job_id: string;
  // 'indeterminate' means read recovery before retrying.
  status: string;
  duplicate: boolean;
  recovery: SomewhereJobsRecovery | null;
  ownership_status?: 'app_user' | 'project_owner';
  owner_subject_id?: string | null;
  // ISO time when run_at was given; status is 'scheduled' until then.
  run_at?: string | null;
}
interface SomewhereJob {
  job_id: string;
  project_id: string;
  handler: string;
  status: string;
  progress: number;
  progress_message: string | null;
  payload: unknown;
  result: unknown;
  error: string | null;
  error_code: string | null;
  webhook_url: string | null;
  webhook_delivered: boolean;
  timeout_seconds: number;
  attempts: unknown[];
  priority: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  ownership_status: 'app_user' | 'project_owner';
  owner_subject_id: string | null;
  cron_id: string | null;
  cron_scheduled_at: string | null;
  trigger: 'scheduled' | 'manual' | null;
  run_at: string | null;
  recovery: SomewhereJobsRecovery | null;
}
interface SomewhereJobsCancelResult {
  job_id: string;
  status: 'cancelled';
  ownership_status: 'app_user' | 'project_owner';
  owner_subject_id: string | null;
}
interface SomewhereRuntimeJobs {
  create(options: SomewhereJobsCreateOptions): Promise<SomewhereJobsCreateResult>;
  status(jobId: string): Promise<SomewhereJob>;
  // Cancels queued work. An ordinary handler already running finishes; its side effects remain.
  cancel(jobId: string): Promise<SomewhereJobsCancelResult>;
  // True only for a platform-signed job/queue/cron delivery; never throws.
  verifyInvocation(req: Request): Promise<boolean>;
}

// ── sw.cron ────────────────────────────────────────────────────────
interface SomewhereCronCreateOptions {
  // 5-field cron expression, evaluated in timezone (UTC by default).
  schedule: string;
  handler: string;
  timezone?: string;
  payload?: unknown;
  name?: string;
  enabled?: boolean;
}
interface SomewhereCron {
  cron_id: string;
  project_id: string;
  name: string | null;
  schedule: string;
  timezone: string;
  handler: string;
  payload: unknown;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_job_id: string | null;
  last_error_code: string | null;
  last_error: string | null;
  consecutive_failures: number;
  paused_reason: string | null;
  next_run_at: string;
  created_at: string;
}
interface SomewhereCronPolicy {
  plan: string;
  enabled: boolean;
  min_interval_minutes: number | null;
  max_per_project: number | null;
}
interface SomewhereRuntimeCron {
  create(options: SomewhereCronCreateOptions): Promise<{ cron_id: string; schedule: string; timezone: string; next_run: string }>;
  list(): Promise<{ crons: SomewhereCron[]; policy: SomewhereCronPolicy }>;
  update(id: string, changes: Partial<SomewhereCronCreateOptions>): Promise<SomewhereCron>;
  delete(id: string): Promise<{ deleted: true; cron_id: string }>;
}

// ── sw.tasks ───────────────────────────────────────────────────────
type SomewhereTaskStatus = 'backlog' | 'open' | 'in_progress' | 'blocked' | 'needs_review' | 'done' | 'archived';
type SomewhereTaskPriority = 'low' | 'normal' | 'high' | 'urgent';
type SomewhereTaskHealth = 'on_track' | 'at_risk' | 'off_track';
interface SomewhereTask {
  id: string;
  title: string;
  description: string | null;
  status: SomewhereTaskStatus;
  priority: SomewhereTaskPriority;
  type: string;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  due_at: number | null;
  area: string | null;
  parent_id: string | null;
  superseded_by: string | null;
  shipped_in: string | null;
  deployment_project_id: string | null;
  attachments: string[];
  status_note: string | null;
  health: SomewhereTaskHealth | null;
  status_note_updated_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}
interface SomewhereTaskListItem extends SomewhereTask {
  description_excerpt: string;
  description_truncated: boolean;
  comment_count: number;
  stale: boolean;
}
interface SomewhereTaskComment {
  id: string;
  task_id: string;
  author: string | null;
  body: string;
  created_at: number;
  [key: string]: unknown;
}
// Full view: the task plus comments, activity, relationships and closure guidance.
interface SomewhereTaskDetail extends SomewhereTask {
  project_id: string;
  comments: SomewhereTaskComment[];
  activity: SomewhereJsonObject[];
  [key: string]: unknown;
}
interface SomewhereTaskCreateOptions {
  title: string;
  description?: string;
  status?: SomewhereTaskStatus;
  priority?: SomewhereTaskPriority;
  type?: string;
  assignee?: string | null;
  reporter?: string;
  labels?: readonly string[];
  due_at?: number | null;
  area?: string;
  parent_id?: string;
  // sw.fs paths.
  attachments?: string | readonly string[] | null;
  template?: string;
}
interface SomewhereTaskUpdateOptions {
  title?: string;
  description?: string | null;
  status?: SomewhereTaskStatus;
  priority?: SomewhereTaskPriority;
  type?: string;
  assignee?: string | null;
  labels?: readonly string[];
  due_at?: number | null;
  area?: string | null;
  parent_id?: string | null;
  superseded_by?: string | null;
  shipped_in?: string | null;
  status_note?: string | null;
  health?: SomewhereTaskHealth | null;
  attachments?: string | readonly string[] | null;
  append_attachments?: string | readonly string[];
  // Positive deploy version number; mutually exclusive with shipped_in.
  deployment_version?: number;
  deployment_project_id?: string;
  // Persisted as a comment; include it when closing a task.
  resolution_note?: string;
  comment?: string;
}
interface SomewhereTaskSettings {
  project_id: string;
  notify_email: string | null;
  webhook_url: string | null;
  webhook_configured: boolean;
}
interface SomewhereRuntimeTasks {
  // The created task, or only its id when the read-back was unavailable.
  create(task: SomewhereTaskCreateOptions): Promise<SomewhereTask | { id: string }>;
  // parent_id: 'null' lists only top-level tasks.
  list(options?: { status?: SomewhereTaskStatus; assignee?: string; area?: string; parent_id?: string | null; limit?: number } | null): Promise<SomewhereTaskListItem[]>;
  get(id: string): Promise<SomewhereTaskDetail>;
  update(id: string, changes: SomewhereTaskUpdateOptions): Promise<SomewhereTask>;
  delete(id: string): Promise<{ id: string; deleted: true }>;
  comment(id: string, body: string, author?: string): Promise<{ id: string; task_id: string; author: string; actor: string; body: string; created_at: number; edited_at: null }>;
  readonly settings: {
    get(): Promise<SomewhereTaskSettings>;
    // webhook_secret is returned once, when a webhook_url is first set.
    update(settings: { webhook_url?: string | null; notify_email?: string | null }): Promise<SomewhereTaskSettings & { webhook_secret: string | null }>;
  };
}

// ── sw.calls ───────────────────────────────────────────────────────
interface SomewhereRuntimeCalls {
  newSession(options?: { thirdparty?: boolean } | null): Promise<{ session_id: string; project_id: string; authorization_status: 'persisted' }>;
}

interface SomewhereRuntimeContext {
  readonly email: SomewhereRuntimeEmail;
  readonly contacts: SomewhereRuntimeContacts;
  readonly inbox: SomewhereRuntimeInbox;
  readonly notifications: SomewhereRuntimeNotifications;
  readonly push: SomewhereRuntimePush;
  readonly queue: SomewhereRuntimeQueue;
  readonly jobs: SomewhereRuntimeJobs;
  readonly cron: SomewhereRuntimeCron;
  readonly tasks: SomewhereRuntimeTasks;
  readonly calls: SomewhereRuntimeCalls;
}
interface __SomewhereTypedRequest<Input> extends Request { json(): Promise<Input> }
type ServerFunction<Contract extends { input: unknown; output: unknown }> =
  (req: __SomewhereTypedRequest<Contract["input"]>, sw: SomewhereRuntimeContext) =>
    Contract["output"] | Promise<Contract["output"]>;

// Outbound WebSocket client: fetch(url, { headers: { Upgrade: 'websocket' } })
// returns the upgraded socket on the response (null on any other response),
// and the function calls accept() before using it. The runtime fetch wrapper
// and the pinned egress transport both hand that response through
// (worker/src/runtime/fetch.ts, routes/code-egress.ts). Merged into lib.dom.
interface Response { readonly webSocket: WebSocket | null }
interface WebSocket { accept(): void }

type SomewhereGroupRole = "owner" | "admin" | "member";
type SomewhereAppRole = never;

interface SomewhereGroup {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  /** The signed-in user's role in this group. */
  role: SomewhereGroupRole;
}

interface SomewhereGroupMember {
  user_id: string;
  role: SomewhereGroupRole;
  created_at: number;
}

/** The group plus the FIRST roster page; continue with members(req, id, { cursor: members_next_cursor }). */
interface SomewhereGroupDetail extends SomewhereGroup {
  members: SomewhereGroupMember[];
  members_next_cursor: string | null;
}

/** One keyset page; next_cursor is null when nothing follows. No total count. */
interface SomewhereGroupsPage<T> {
  items: T[];
  next_cursor: string | null;
}

/** limit 1–100 (default 50); cursor is a previous page's next_cursor. */
interface SomewhereGroupsPageOptions {
  cursor?: string;
  limit?: number;
}

interface SomewhereAppRoleGrant {
  user_id: string;
  role: SomewhereAppRole;
  granted_by: string;
  grant_source: 'platform_admin' | 'delegation';
  created_at: number;
}

/** A sent group invitation: one email; acceptance completes the membership. */
interface SomewhereGroupInvitation {
  invite: { id: string; email: string; status: 'pending'; redirect_uri: string; expires_at: number; created_at: number };
  group: { group_id: string; role: SomewhereGroupRole };
  delivery: 'sent' | 'pending';
}

/**
 * Where an accepted invitation's membership stands. pending: not confirmed
 * yet (the platform retries on this user's next list); refused: it will not
 * complete (code says why, e.g. INVITATION_REVOKED, INVITATION_AUTHORITY_LOST).
 */
interface SomewhereGroupInvitationOutcome {
  invite_id: string;
  group_id: string;
  role: SomewhereGroupRole;
  state: 'completed' | 'pending' | 'refused';
  code?: string;
}

/** Expected refusals and unconfirmed outcomes resolve with retry:false; changes are never re-sent. */
interface SomewhereGroupsError {
  code: string;
  message: string;
  status: number;
  retry: false;
  data?: Record<string, unknown>;
}

type SomewhereGroupsResult<T> = { data: T; error: null } | { data: null; error: SomewhereGroupsError };

/**
 * Every method acts as the user signed in on the request this function was
 * invoked with, read once from that original request. The `req` argument is
 * accepted for compatibility and never read: passing another Request cannot
 * change who acts, and no method accepts an acting user. Groups are available
 * on the live app only; a preview, a dev run, a job delivery or a signed-out
 * request resolves with data:null and a non-retryable error before any change.
 */
interface SomewhereGroups {
  create(req: Request, input: { name: string }): Promise<SomewhereGroupsResult<SomewhereGroupDetail>>;
  /** Also completes (and reports) up to 3 of the signed-in user's accepted invitations. */
  list(req: Request, opts?: SomewhereGroupsPageOptions): Promise<SomewhereGroupsResult<SomewhereGroupsPage<SomewhereGroup> & { invitations: SomewhereGroupInvitationOutcome[] }>>;
  get(req: Request, groupId: string): Promise<SomewhereGroupsResult<SomewhereGroupDetail>>;
  members(req: Request, groupId: string, opts?: SomewhereGroupsPageOptions): Promise<SomewhereGroupsResult<SomewhereGroupsPage<SomewhereGroupMember>>>;
  /** Invite by email with a role the signed-in user may grant. The platform
   *  sends one email and adds the member when they accept; no app call is needed. */
  invite(req: Request, groupId: string, input: { email: string; role: SomewhereGroupRole; redirect_uri: string; expires_in?: number }): Promise<SomewhereGroupsResult<SomewhereGroupInvitation>>;
  /** Revoke in the invitation's own group, as its sender or a member who may grant its role. */
  revokeInvitation(req: Request, inviteId: string): Promise<SomewhereGroupsResult<{ revoked: true }>>;
  leave(req: Request, groupId: string): Promise<SomewhereGroupsResult<{ left: true }>>;
  remove(req: Request, groupId: string, userId: string): Promise<SomewhereGroupsResult<{ removed: true }>>;
  setRole(req: Request, groupId: string, userId: string, role: SomewhereGroupRole): Promise<SomewhereGroupsResult<{ user_id: string; role: SomewhereGroupRole }>>;
  appRoles: {
    list(req: Request, userId?: string, opts?: SomewhereGroupsPageOptions): Promise<SomewhereGroupsResult<SomewhereGroupsPage<SomewhereAppRoleGrant>>>;
    grant(req: Request, userId: string, role: SomewhereAppRole): Promise<SomewhereGroupsResult<SomewhereAppRoleGrant>>;
    revoke(req: Request, userId: string, role: SomewhereAppRole): Promise<SomewhereGroupsResult<{ revoked: boolean }>>;
  };
}

interface SomewhereRuntimeContext {
  readonly groups: SomewhereGroups;
}

interface SomewhereEndpointUser {
  id: string;
  email?: string | null;
  display_name?: string | null;
  role?: string;
  [key: string]: unknown;
}
type __SomewhereEndpointLeaf = 'string' | 'email' | 'number' | 'boolean' | 'array' | 'object';
interface SomewhereEndpointBodySchema {
  readonly [field: string]: __SomewhereEndpointLeaf | `${__SomewhereEndpointLeaf}?` | SomewhereEndpointBodySchema;
}
type __SomewhereEndpointValue<T> =
  T extends 'string' | 'email' ? string : T extends 'number' ? number : T extends 'boolean' ? boolean
    : T extends 'array' ? unknown[] : T extends 'object' ? Record<string, unknown> : never;
type __SomewhereEndpointBody<S> = {
  -readonly [K in keyof S as S[K] extends `${string}?` ? never : K]:
    S[K] extends string ? __SomewhereEndpointValue<S[K]> : __SomewhereEndpointBody<S[K]>;
} & {
  -readonly [K in keyof S as S[K] extends `${string}?` ? K : never]?:
    S[K] extends `${infer T}?` ? __SomewhereEndpointValue<T> | null : never;
};
type SomewhereEndpointAuth = 'none' | 'optional' | 'required';
interface SomewhereEndpointInput<Auth extends SomewhereEndpointAuth, Body> {
  body: Body;
  user: Auth extends 'required' ? SomewhereEndpointUser : SomewhereEndpointUser | null;
  headers: Headers;
  params: Record<string, string>;
  request: Request;
}
interface SomewhereEndpointConfig<Auth extends SomewhereEndpointAuth, Schema extends SomewhereEndpointBodySchema | undefined> {
  auth?: Auth;
  body?: Schema;
  rateLimit?: `${number}/${'second' | 'minute' | 'hour' | 'day'}${'' | 's'}`;
  cors?: 'same-origin' | '*' | readonly string[];
  handler(
    input: SomewhereEndpointInput<Auth, Schema extends SomewhereEndpointBodySchema ? __SomewhereEndpointBody<Schema> : null>,
    sw: SomewhereRuntimeContext,
  ): unknown;
}
