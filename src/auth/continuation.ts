/** Internal auth response parsing. Pending credentials never enter user state. */
export function authData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  return record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown> : record;
}

export function mfaChallenge(value: unknown): { mfa_required: true; mfa_token: string } | null {
  const data = authData(value);
  const candidate = data?.mfa_required === true ? data : authData(data?.user);
  if (candidate?.mfa_required !== true || typeof candidate.mfa_token !== 'string' || !candidate.mfa_token) return null;
  return { mfa_required: true, mfa_token: candidate.mfa_token };
}

export function isAuthUser(value: unknown): value is { id: string } & Record<string, unknown> {
  return !!value && typeof value === 'object'
    && typeof (value as Record<string, unknown>).id === 'string'
    && !!(value as Record<string, unknown>).id
    && !('mfa_required' in value) && !('mfa_token' in value);
}
