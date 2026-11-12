# Authentication convergence

Decision record: 2026-07-28 (``). For current application setup,
start with the [SDK README](../README.md).

## Only-path contract

| Environment | Session transport | Browser credentials | Data access |
|---|---|---:|---|
| Browser app | Same-origin `/api/auth` handler backed by `sw.auth.*WithCookie` / `fromRequest`; `HttpOnly` cookie session | Zero | Schema-generated `somewhere:data` and `somewhere:files` for declared operations; same-origin server functions for trusted logic using `sw.db` / `sw.fs` |
| Script, agent, CLI, server, native app | `Authorization: Bearer` plus explicit refresh rotation | Not applicable | SDK/platform API as allowed by the credential |

Founder ruling, 2026-07-28: one package. `@somewhere-tech/sdk` owns the
cookie-native client, server handler, React providers/hooks/gates, and the
explicit platform client with its established fluent query builder. The focused entry points are
`@somewhere-tech/sdk/auth`, `@somewhere-tech/sdk/server`, and
`@somewhere-tech/sdk/react`. `@somewhere-tech/auth` is a thin re-export shim;
standalone-package deprecation is deferred until usage proves safe.

## Naming and result-shape alignment

| Intent | `@somewhere-tech/sdk/auth` | Root `@somewhere-tech/sdk` | Current status |
|---|---|---|---|
| Password sign-in | `signIn(input) → User` | `signInWithPassword(input) → Result<AuthResponse>` | `signIn` added as a non-breaking SDK alias; SDK keeps its Result envelope |
| Sign up | `signUp(input) → User` | `signUp(input) → Result<AuthResponse>` | Same transport; different envelope retained for compatibility |
| Start passwordless | `sendMagicLink(input) → void` | `sendMagicLink(input) → Result<{sent:true}>` | Same `/api/auth/magic-link` adapter route |
| Complete passwordless | `verifyMagicLink(input) → User` | `verifyMagicLink(input) → Result<AuthResponse>` | Same `/api/auth/magic-link/verify` adapter route |
| Password reset completion | Not currently exposed | `verifyPasswordReset(input)` | Clear name added |
| Historical `verifyOtp` | Passwordless runtime terminology | Password-reset alias | Deprecated but retained; delegates to `verifyPasswordReset` |
| Current user | `getUser() → User|null` | `getUser() → Result<{user}>` | Same `/api/auth/me` transport; envelope retained |
| Sign out | `signOut() → void` | `signOut() → Result<null>` | Same `/api/auth/logout` transport; envelope retained |

## Implemented without breaking users

- Browser password, passwordless, current-user, and sign-out calls share the
  `/api/auth` handler contract and cookie handshake used by
  `@somewhere-tech/sdk/server`.
- Existing `signInWithPassword` remains; `signIn` is additive.
- Existing password-reset `verifyOtp` remains and warns through types/docs by
  being marked deprecated; `verifyPasswordReset` is the clear additive name.
- The root client retains direct database/files methods for explicit
  server/non-browser integrations. A cookie-only browser client has no bearer
  credential for those calls; use the generated browser clients or same-origin
  functions. `functions.invoke` includes browser cookies.
- Header mode remains unchanged for non-browser clients and legacy sessions.

## Historical rollout constraints (July 2026)

These constraints record the original auth convergence decision, not current
platform guardrail policy.

- Removing either source-compatible SDK auth shape.
- Changing the root SDK's `{ data, error, status }` contract to the auth
  subpath's throw/return-User convention, or changing the subpath in the
  opposite direction.
- Removing `signInWithPassword`, `verifyOtp`, header-mode browser fallback, or
  direct browser database/files calls.
- Making direct browser database/files warnings into deploy/runtime blockers.
  Rule 9 requires a warning cycle, migration evidence, and passing legitimate
  fixtures first.
- Replacing the current Google-only root `signInWithOAuth` API with the auth
  subpath's provider-specific methods. Provider parity can be additive, but the
  callback contract must be designed and tested before it is advertised.
