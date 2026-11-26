// Framework-agnostic cookie-native auth adapter.
// React bindings live at "@somewhere-cloud/sdk/react"; the backend handler at
// "@somewhere-cloud/sdk/server".
export {
  AuthError,
  createSomewhereAuth,
  type AppUserRole,
  type AuthMode,
  type AuthState,
  type AuthStatus,
  type BillingClient,
  type BillingPlan,
  type MfaCodeSent,
  type Session,
  type SomewhereAuth,
  type SomewhereAuthOptions,
  type StorageLike,
  type User,
} from './client.js';
