# @matanetwork/sovereign-id

Page-side SDK for **MATA Sovereign ID** (mID) — the permissionless
self-issued identity protocol.

Drop one button into your sign-in page. Users authenticate with their
own wallet (browser extension or native app). You get back a signed
JWT carrying a stable DID + the claims they consented to disclose.
No `client_id`, no portal account, no MAU pricing, no MATA HTTP
traffic at runtime.

## Install

```bash
npm install @matanetwork/sovereign-id
```

Pair with the backend verifier (separate package, same protocol):

```bash
npm install @matanetwork/sovereign-id-verify
```

## Quick start

```javascript
import { signIn, resumePendingSignIn, SignInError } from '@matanetwork/sovereign-id';

// 1. On boot — resume an interrupted sign-in if one was stashed.
//    Returns null when there's nothing pending; the normal page renders.
resumePendingSignIn().then(handleResult);

// 2. On sign-in button click — start a fresh request.
document.getElementById('signin').addEventListener('click', async () => {
  try {
    const nonce = await fetch('/api/auth/nonce').then(r => r.text());
    const result = await signIn({
      rpOrigin: 'https://acme.com',
      nonce,
      claims: {
        required: ['did'],
        optional: ['email', 'name'],
      },
    });
    handleResult(result);
  } catch (err) {
    if (err instanceof SignInError) handleSignInError(err);
    else throw err;
  }
});

async function handleResult(result) {
  if (!result) return;  // resumePendingSignIn returned null — nothing to do.

  // Hand the JWT to your backend for verification.
  const resp = await fetch('/api/auth/mid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jwt: result.jwt }),
  });
  if (resp.ok) window.location.href = '/dashboard';
}

function handleSignInError(err) {
  switch (err.code) {
    case 'user_denied':       /* user clicked Deny on the consent screen */ break;
    case 'upsell_canceled':   /* user dismissed the install upsell */ break;
    case 'timeout':           /* user left the consent screen open too long */ break;
    case 'origin_mismatch':   /* page lied about its origin (rare) */ break;
    default: console.error(err.code, err.message);
  }
}
```

That's it. No back-channel `/token` exchange. No JWKS to refresh. The
JWT is self-anchored — your backend verifies it entirely against
cryptographic material embedded in the token.

## API reference

### `signIn(request, options?)`

Probes for the MATA browser extension first; falls back to the
`mata-mid://` native-app deep link. If neither responds, an install
upsell modal opens (links to the Chrome Web Store, polls for the
extension, auto-resumes once installed).

#### `request` — required

| Field | Type | Notes |
|---|---|---|
| `rpOrigin` | `string` | Your bare origin, e.g. `"https://acme.com"`. Becomes the JWT's `aud` claim. |
| `nonce` | `string` | Single-use random string from your backend. Echoed in the JWT for replay defense. |
| `claims.required` | `string[]` | Claim keys the user MUST approve. Almost always `["did"]`. Denial blocks sign-in. |
| `claims.optional` | `string[]` | Claim keys the user can include or skip. |
| `claims.custom` | `Record<string, {optional: true, description?: string}>` | Arbitrary keys from the user's `profile_kv` (v0: ignored by the wallet). |

**Standard claim catalog (v1):** `did`, `email`, `name`, `created_at`,
`paired_devices_count`, `level_rating.trust`, `level_rating.security`,
`level_rating.incentive`.

#### `options` — optional

| Field | Type | Default | Notes |
|---|---|---|---|
| `timeoutMs` | `number` | `120000` | Hard request timeout. |
| `nativeAppCallback` | `string` | `window.location.href` | URL the native app's callback redirects to. |
| `installUpsell` | `boolean` | `true` | When `false`, `ERR_NO_WALLET_INSTALLED` is thrown raw instead of showing the modal. |
| `ref` | `string \| null` | hostname of `rpOrigin` | Referral code stamped onto the upsell's outbound links. Default delivers attribution back to your domain. Pass `null` to opt out. |

#### Returns

`Promise<{ jwt: string, surface: 'extension' | 'native_app' }>`.

#### Throws

`SignInError` with `.code` one of:

| Code | When |
|---|---|
| `user_denied` | User clicked Deny on the consent screen. |
| `upsell_canceled` | User dismissed the install upsell ("Cancel" or Escape). |
| `no_wallet_installed` | Only when `installUpsell: false`. Neither extension nor native app responded. |
| `invalid_request` | Your code passed a malformed request (caught on the page). |
| `origin_mismatch` | Page-claimed origin didn't match the actual tab origin. Possible page bug or attack. |
| `wallet_unavailable` | Vault locked, wallet not bootstrapped, or no matching credential. |
| `required_claim_unavailable` | User signed up without an email but you required it. |
| `timeout` | User didn't decide within `timeoutMs`. |
| `internal_error` | Anything else. |

### `resumePendingSignIn()`

Call once at app boot. Resumes a sign-in that was interrupted by a
page reload during the install upsell.

| Returns | When |
|---|---|
| `{ jwt, surface }` | A pending request was stashed, the extension is now installed, and the resumed sign-in completed. |
| `null` | No pending request, or the stash is stale, or the extension is still missing. |
| `throws SignInError` | A pending request exists and the extension is present, but the resumed sign-in itself failed. |

The stash lives in `sessionStorage` (per-tab, cleared on tab close).
TTL = the original request's `timeoutMs`. Stale entries are silently
dropped on read.

### `hasExtension()`

Returns `true` when `window.__mata_mid__` (set by the extension's
content script) is present. Useful for conditionally rendering the
sign-in button vs. an install prompt before the user has clicked.

> **Race-condition note.** The content script runs at `document_idle`.
> RPs calling `signIn()` synchronously from `<head>` may probe before
> the script is injected. Call after `DOMContentLoaded` (or after a
> user gesture) to avoid the false negative.

### `showInstallUpsell(options)`

Exposed for RPs who set `installUpsell: false` and want to render the
upsell on their own conditions (e.g. after their own UI flow). Same
modal `signIn()` uses internally; same `'installed' | 'canceled'`
result shape.

### `pickInstallCta()` / `defaultRefFromOrigin(origin)`

Helpers for RPs building their own install upsell UI:

- `pickInstallCta()` returns the right `{label, url, hint}` for the
  current browser/OS.
- `defaultRefFromOrigin('https://acme.com')` returns `'acme.com'` — the
  referral code the SDK would stamp by default.

### `clearPendingSignIn()`

Imperatively drops the resume stash. Use when you've navigated to a
different sign-in flow that supersedes the pending mID request.

### `SignInError`

```typescript
class SignInError extends Error {
  readonly code: ErrorCode;
}
```

## Referral attribution

Both outbound links in the install upsell modal carry `?ref=<code>` by
default — your domain becomes the attribution code without any extra
wiring. The signup flow at my.mata.network reads `?ref=` and forwards
it through to your downstream analytics as `referral_code`.

Customize:

```javascript
signIn(request, { ref: 'acme-launch-2026' });  // custom code
signIn(request, { ref: null });                // opt out
```

## What you don't have to think about

- **No `client_id`, `client_secret`, redirect URI allowlist.** There's no registration step.
- **No `/token` back-channel exchange.** The JWT comes back from `signIn()` directly.
- **No JWKS endpoint refresh.** The JWT bundles its own resolution data.
- **No DID-resolver HTTP calls.** The DID is its own public key.
- **No MAU pricing.** No metering of any kind.

## Verification on the backend

Use [@matanetwork/sovereign-id-verify](https://npmjs.com/package/@matanetwork/sovereign-id-verify):

```javascript
import { verifyResponse } from '@matanetwork/sovereign-id-verify';

const verified = await verifyResponse(req.body.jwt, {
  expectedAudience: 'https://acme.com',
  expectedNonce: sessionNonce,
  nowUnixSecs: Math.floor(Date.now() / 1000),
});

// verified.did            — stable user identifier
// verified.claims         — disclosed values
// verified.currentVersion — head roster version; cache for rollback detection
```

## Browser support

| Browser | Sign-in path |
|---|---|
| Chrome / Edge / Brave / Arc / Opera | Extension or native-app deep link |
| Safari | Native-app deep link (extension coming) |
| Firefox | Native-app deep link (extension coming) |
| Mobile Chrome / Safari | Native-app deep link (apps coming) |

When no compatible surface is available, the install upsell modal
surfaces the right CTA per browser/OS automatically.

## Accessibility

The install upsell modal:

- Renders in a closed Shadow DOM (RP CSS can't break or skin it).
- Traps Tab / Shift+Tab focus inside the modal.
- Restores focus to the element that was focused before opening.
- Closes on Escape and on backdrop click.
- Shows `:focus-visible` outlines for keyboard users.
- Uses `role="dialog"` + `aria-modal="true"` + `aria-labelledby`.

## License

MIT — see [LICENSE](LICENSE).
