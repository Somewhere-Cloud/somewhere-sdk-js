import React from 'react';
import { createRoot } from 'react-dom/client';
import { SomewhereAuthProvider, useAuthState, useAuth, SignedIn, SignedOut, Protect } from '../../src/auth/react.js';
function App() {
  const state = useAuthState();
  const auth = useAuth();
  Object.assign(window, { fixtureAuth: auth });
  return <main>
    <SignedIn><p data-testid="private">Private helper content</p></SignedIn>
    <SignedOut pending={<p data-testid="signedout-pending">Pending</p>}><p data-testid="signedout-form">Signed out helper</p></SignedOut>
    <Protect pending={<p data-testid="protect-pending">Pending</p>} fallback={<p data-testid="protect-form">Signed out</p>}><p data-testid="protected-private">Protected helper content</p></Protect>
    <output data-testid="pending">{String(state.signingOut)}</output>
    <output data-testid="unconfirmed">{String(state.signOutUnconfirmed)}</output>
    {state.user ? <button data-testid="logout" onClick={() => { void auth.signOut(); }}>Sign out</button> : <p data-testid="form">Sign in</p>}
    <button data-testid="retry" onClick={() => { void auth.signOut(); }}>Retry</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<SomewhereAuthProvider><App /></SomewhereAuthProvider>);
