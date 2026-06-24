# @matanetwork/sovereign-id-react

React adapter for [`@matanetwork/sovereign-id`](https://www.npmjs.com/package/@matanetwork/sovereign-id).
Drop in a `<SignInButton/>`, get a signed JWT carrying a verified
DID + the user's consented claims.

Lowers your integration from ~20 LOC + manual state plumbing to one
component or one hook.

## Install

```bash
npm install @matanetwork/sovereign-id-react @matanetwork/sovereign-id react
```

`react` is a peer dependency — works with React 17, 18, and 19.

For the backend verifier, also install [`@matanetwork/sovereign-id-verify`](https://www.npmjs.com/package/@matanetwork/sovereign-id-verify).

## Quick start — drop-in button

```jsx
import { SignInButton } from '@matanetwork/sovereign-id-react';

function LoginPage() {
  return (
    <SignInButton
      getNonce={() => fetch('/api/auth/nonce').then((r) => r.text())}
      claims={{ required: ['did'], optional: ['email', 'name'] }}
      onSuccess={({ jwt }) =>
        fetch('/api/auth/mid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jwt }),
        }).then(() => (window.location.href = '/dashboard'))
      }
      onCancel={(code) => console.log('user cancelled:', code)}
      onError={(err) => console.error(err.code, err.message)}
    />
  );
}
```

That's it. The button:

- Fetches a nonce from your backend
- Probes for the MATA extension → falls back to the native-app deep
  link → falls back to the install upsell modal
- Resolves the user's consent decision
- Hands you `{ jwt, surface }` on success

## Hook — custom button styling

When you want full control over the rendered button:

```jsx
import { useSignIn } from '@matanetwork/sovereign-id-react';

function LoginPage() {
  const { signIn, isLoading, error } = useSignIn({
    rpOrigin: 'https://acme.com',
    getNonce: () => fetch('/api/auth/nonce').then((r) => r.text()),
    defaultClaims: { required: ['did'], optional: ['email'] },
  });

  return (
    <>
      <button
        onClick={async () => {
          try {
            const { jwt } = await signIn();
            await fetch('/api/auth/mid', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jwt }),
            });
            window.location.href = '/dashboard';
          } catch {
            /* useSignIn already mirrors the error into `error` */
          }
        }}
        disabled={isLoading}
        className="my-styled-button"
      >
        {isLoading ? 'Signing in…' : 'Sign in with MATA'}
      </button>
      {error && <p role="alert">{error.message}</p>}
    </>
  );
}
```

`useSignIn` returns `{ signIn, reset, status, isLoading, result, error }`.
Status is `'idle' | 'pending' | 'success' | 'error'`.

## Resume after page reload

The install upsell flow stashes a pending sign-in in `sessionStorage`
so it survives a reload (common when Chrome prompts the user to
reload after extension install). Wire the resume at the root of your
app:

```jsx
import { useResumePendingSignIn } from '@matanetwork/sovereign-id-react';

function App() {
  useResumePendingSignIn({
    onSuccess: ({ jwt }) => {
      fetch('/api/auth/mid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jwt }),
      }).then(() => (window.location.href = '/dashboard'));
    },
  });

  return <Routes>{/* ... */}</Routes>;
}
```

The hook fires once on mount, looks for a stashed pending sign-in,
and invokes `onSuccess` if one resumes. If you want to delay
rendering your logged-out UI until the resume check completes (avoids
a flicker), watch the `noResume` flag:

```jsx
const { noResume, status } = useResumePendingSignIn({ onSuccess });
if (status === 'pending') return <Spinner />;
// noResume === true once we've confirmed nothing was pending
```

## API

### `<SignInButton/>`

| Prop | Type | Required | Notes |
|---|---|---|---|
| `getNonce` | `() => Promise<string>` | yes | Async fn returning a fresh single-use nonce. |
| `claims` | `{ required, optional?, custom? }` | yes | Standard SDK claim shape. |
| `onSuccess` | `(result) => void` | yes | Called with `{ jwt, surface }`. |
| `onCancel` | `(code) => void` | no | Called on `user_denied` or `upsell_canceled`. |
| `onError` | `(err: SignInError) => void` | no | Called on any other failure path. |
| `rpOrigin` | `string` | no | Default: `window.location.origin`. |
| `installUpsell` | `boolean` | no | Default: SDK default (`true`). |
| `ref` | `string \| null` | no | Referral code. Default: hostname of `rpOrigin`. |
| `timeoutMs` | `number` | no | Default: 120000. |
| `nativeAppCallback` | `string` | no | Default: `window.location.href`. |
| `children` | `ReactNode` | no | Button label. Default: `"Sign in with Sovereign ID"`. |
| `className` | `string` | no | When set, default inline styles are NOT applied. |
| `style` | `CSSProperties` | no | Merged with default inline styles when `className` is unset. |
| `disabled` | `boolean` | no | OR'd with the internal in-flight disabled state. |
| `buttonProps` | `object` | no | Spread onto the `<button>` (aria-*, data-*, etc.). |

### `useSignIn(options?)`

| Option | Type | Notes |
|---|---|---|
| `rpOrigin` | `string` | Default: `window.location.origin`. |
| `getNonce` | `() => Promise<string>` | Required unless you pass `nonce` to every `signIn()` call directly. |
| `defaultClaims` | `claims` | Default `claims` payload. |
| `installUpsell`, `ref`, `timeoutMs`, `nativeAppCallback` | — | Forwarded to the SDK. |

Returns:

```ts
{
  signIn(overrides?): Promise<{ jwt, surface } | null>;
  reset(): void;
  status: 'idle' | 'pending' | 'success' | 'error';
  isLoading: boolean;
  result: { jwt, surface } | null;
  error: SignInError | null;
}
```

The hook protects against stale calls — if you click sign-in twice
in a row, only the most recent call's result commits to state.

### `useResumePendingSignIn(options?)`

| Option | Type | Notes |
|---|---|---|
| `onSuccess` | `(result) => void` | Called when a resume completes with a JWT. |
| `onError` | `(err) => void` | Called when a resume threw. |
| `onNothingPending` | `() => void` | Called when there's nothing to resume — most boots. |

Returns:

```ts
{
  status: 'idle' | 'pending' | 'success' | 'error';
  result: { jwt, surface } | null;
  error: SignInError | null;
  noResume: boolean;
}
```

### Re-exports from the core SDK

For convenience, this package re-exports everything from
`@matanetwork/sovereign-id` so you only need one import line:

```js
import {
  SignInError,
  ERR_USER_DENIED,
  ERR_UPSELL_CANCELED,
  hasExtension,
  defaultRefFromOrigin,
  // ...
} from '@matanetwork/sovereign-id-react';
```

## Backend

Same as the core SDK — use [`@matanetwork/sovereign-id-verify`](https://www.npmjs.com/package/@matanetwork/sovereign-id-verify):

```js
import { verifyResponse } from '@matanetwork/sovereign-id-verify';

const verified = await verifyResponse(req.body.jwt, {
  expectedAudience: 'https://acme.com',
  expectedNonce: sessionNonce,
  nowUnixSecs: Math.floor(Date.now() / 1000),
});
```

See the
[main docs](https://github.com/Remade-With-Rust/sovereign-id/tree/main/docs/sovereign-id)
for the integration guide, error-handling matrix, and protocol spec.

## What you don't have to think about

- Wallet detection (extension vs. native app vs. install upsell)
- Resume after page reload
- Referral attribution (your domain rides along to `my.mata.network/signup` by default)
- Stale-call state collisions
- React 18 strict-mode double-mount during boot resume

## License

MIT — see [LICENSE](LICENSE).
