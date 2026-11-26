import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SomewhereAuthProvider, useAuthState, useAuth, SignedIn, SignedOut, Protect } from '../../src/auth/react.js';
import { createSomewhereAuth } from '../../src/auth/client.js';

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
    <output data-testid="cached-user">{state.user?.id}</output>
    <output data-testid="status">{state.status}</output>
    {state.status === 'checking' ? <p data-testid="natural-loading">Loading</p> : state.status === 'authenticated' ? <p data-testid="natural-private">Account</p> : <p data-testid="natural-form">Sign in</p>}
    {state.user ? <button data-testid="logout" onClick={() => { void auth.signOut(); }}>Sign out</button> : <p data-testid="form">Sign in</p>}
    <button data-testid="retry" onClick={() => { void auth.signOut(); }}>Retry</button>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
const variant = new URLSearchParams(location.search).get('variant');
if (variant === 'shared') {
  const client = createSomewhereAuth();
  const mount = (key: string) => flushSync(() => root.render(
    <SomewhereAuthProvider client={client} key={key}><App /></SomewhereAuthProvider>
  ));
  void client.getUser().then(() => {
    mount('first');
    Object.assign(window, { fixtureRemount: () => mount('second') });
  });
} else {
  const app = <SomewhereAuthProvider><App /></SomewhereAuthProvider>;
  root.render(variant === 'strict' ? <React.StrictMode>{app}</React.StrictMode> : app);
}
