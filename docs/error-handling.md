# Error handling

Every error code, when it fires, and the recommended UX for each.

## Page-side errors (`SignInError`)

All errors from `signIn()` and `resumePendingSignIn()` are
`SignInError` instances. Branch on `.code`:

```javascript
try {
  await signIn(request);
} catch (err) {
  if (err instanceof SignInError) {
    switch (err.code) {
      case 'user_denied':       /* ... */ break;
      case 'upsell_canceled':   /* ... */ break;
      case 'timeout':           /* ... */ break;
      // ...
    }
  } else {
    // Non-SDK error — your bug or a network failure.
    throw err;
  }
}
```

### `user_denied`

**Fires when.** User clicked "Deny" on the consent screen.

**Recommended UX.** Silent. Don't show an error toast — the user made
an intentional choice. Maybe gray out the sign-in button briefly to
acknowledge.

```javascript
case 'user_denied':
  return;  // user said no; respect it
```

### `upsell_canceled`

**Fires when.** User dismissed the install upsell modal ("Cancel",
Escape, or backdrop click).

**Recommended UX.** Show a small follow-up message: "Sign in with
MATA requires the MATA wallet. [Install] [Skip]." Different from
`user_denied` in that the user hasn't made a *choice* about your
app — they declined to install MATA.

```javascript
case 'upsell_canceled':
  showSmallBanner('Sign in with MATA requires installing it first.');
  return;
```

If you want to control this UX entirely, pass `installUpsell: false`
and handle `ERR_NO_WALLET_INSTALLED` yourself.

### `no_wallet_installed`

**Fires when.** ONLY when you pass `installUpsell: false`. Indicates
neither the extension nor a native app responded.

**Recommended UX.** Show your own install upsell. The SDK gives you
the helpers:

```javascript
import { pickInstallCta, showInstallUpsell } from '@matanetwork/sovereign-id';

case 'no_wallet_installed':
  const cta = pickInstallCta();
  // Render however you like, then retry.
  break;
```

### `invalid_request`

**Fires when.** Your code passed a malformed request — `rpOrigin`
isn't a string, `nonce` is empty, `claims.required` isn't an array,
etc. Caught synchronously on the page.

**Recommended UX.** This is a bug in your code, not a user error.
Log to your error tracker; show the user a generic "something went
wrong" with a retry button.

```javascript
case 'invalid_request':
  reportToSentry(err);
  showError('Something went wrong on our end. Please refresh and try again.');
  break;
```

### `origin_mismatch`

**Fires when.** The page claimed an `rpOrigin` that doesn't match the
actual tab origin. The wallet rejects this as a security check.

In practice this only fires if:

- Your code passed the wrong `rpOrigin` (use `window.location.origin`).
- A malicious page tried to impersonate you and the wallet caught it.

**Recommended UX.** Same as `invalid_request` — it's structurally a
bug. Log + retry.

### `wallet_unavailable`

**Fires when.** The wallet's vault is locked, the user hasn't
bootstrapped their MATA account yet, no credential matches the
active user, or the persisted DID doesn't match the current #root
pubkey (the rollback-protection guard).

**Recommended UX.** "Your MATA wallet isn't ready. Open MATA, unlock,
and try again." Don't auto-retry — the user needs to take an action
in the wallet first.

```javascript
case 'wallet_unavailable':
  showError('Your MATA wallet isn\'t ready. Open MATA, unlock, then click again.');
  break;
```

### `required_claim_unavailable`

**Fires when.** You required a claim the user doesn't have set (e.g.
required `email` but user signed up without one).

**Recommended UX.** Tell the user specifically what they need to set
up. The error's `.message` carries the claim key:

```javascript
case 'required_claim_unavailable':
  showError(`MATA can't share ${extractClaimKey(err.message)}. Add it in your MATA profile, then sign in again.`);
  break;
```

For best UX, only put claims in `required` that nearly every user
will have — `did` is the only universal one. Put email/name in
`optional` and handle their absence in your downstream logic.

### `timeout`

**Fires when.** User didn't approve consent within `timeoutMs`
(default 2 min).

**Recommended UX.** "Sign-in timed out — try again?" Common when:

- User opened the consent screen and got distracted.
- User had to install MATA from the upsell, completed install + signup,
  then came back AFTER the 2-min window.

```javascript
case 'timeout':
  showError('Sign-in took too long. Click Sign In to try again.');
  break;
```

For the install-then-return case, you can increase `timeoutMs` to
e.g. 5 min to give a buffer.

### `internal_error`

**Fires when.** Anything we didn't categorize. Look at `.message` for
context.

**Recommended UX.** Generic error + retry. Log to your error tracker.

```javascript
case 'internal_error':
  reportToSentry(err);
  showError('Something went wrong. Please try again.');
  break;
```

## Backend errors (`VerifyError`)

All errors from `verifyResponse()` and `checkRollback()` are
`VerifyError` instances. The `.code` is a snake_case string derived
from the Rust `mid_verify::VerifyError` enum.

### Cryptographic failures — return 401

If any of these fire, the token is invalid. **Always return 401 to
the page** — don't reveal which check failed (that's an attacker
oracle).

| Code | Means |
|---|---|
| `signature_invalid` | JWS outer signature didn't verify. Token is forged or corrupted. |
| `signature_wrong_length` | Signature isn't 64 bytes. Malformed token. |
| `genesis_signature_invalid` | Embedded genesis wasn't signed by the DID's key. Forged. |
| `roster_chain_signature_invalid` | A chain entry's signature doesn't verify. Forged or tampered. |
| `head_vm_not_in_roster` | JWT signer isn't in the head roster. Forged. |
| `malformed_did` | DID isn't `did:mata:<base58btc>`. Malformed. |
| `header_invalid` | JWT header isn't `{alg: "ES256", typ: "JWT"}`. Malformed. |
| `payload_json` | Payload isn't valid JSON. Malformed. |

```javascript
catch (e) {
  if (e instanceof VerifyError) {
    console.warn('verify rejected', e.code);
    return res.status(401).json({ error: 'auth_failed' });
  }
}
```

### Replay / staleness — return 401 with a hint

| Code | Means | UX |
|---|---|---|
| `nonce_mismatch` | JWT's `nonce` didn't match `expectedNonce`. Replay attempt, or the user took too long and the nonce expired. | "Sign-in session expired. Click Sign In again." |
| `expired` | Now is past JWT's `exp`. The token aged out between issue and submit. | Same — retry. |
| `iat_skew_too_large` | JWT's `iat` is too far in the past. Clock skew between user device and your server. | Same — retry. (If you see this often, your `maxIatSkewSecs` may be too tight.) |
| `audience_mismatch` | JWT's `aud` doesn't match `expectedAudience`. The user signed for a different RP. | Reject with 401; log for investigation. |

```javascript
catch (e) {
  if (e instanceof VerifyError) {
    if (['nonce_mismatch', 'expired', 'iat_skew_too_large'].includes(e.code)) {
      return res.status(401).json({ error: 'session_expired' });
    }
    return res.status(401).json({ error: 'auth_failed' });
  }
}
```

### Rollback — return 401 and flag for review

| Code | Means |
|---|---|
| `rollback_detected` | (from `checkRollback`) JWT's `currentVersion` is less than your stored value. Old token re-presented after a roster mutation. |

This is a genuine security signal. Log loudly:

```javascript
try {
  checkRollback(verified, existing.last_seen_version);
} catch (e) {
  if (e.code === 'rollback_detected') {
    logger.security_warn('rollback attempt', {
      did: verified.did,
      claimed_version: verified.currentVersion,
      stored_version: existing.last_seen_version,
    });
    return res.status(401).json({ error: 'auth_failed' });
  }
  throw e;
}
```

### Genesis hash mismatch — return 401, may need user contact

```javascript
if (existing.genesis_roster_hash !== verified.genesisRosterHash) {
  return res.status(401).json({ error: 'identity_mismatch' });
}
```

A different `genesis_roster_hash` for the same DID means a new wallet
is presenting as that user. Possible causes:

- The user reset MATA (lost device + restored from a backup that
  somehow regenerated genesis).
- An attacker has obtained the same DID (cryptographically impossible
  outside of full key compromise).

In practice if you see this for a real user, they need a manual
account-recovery flow.

## A complete error-handling reference implementation

```javascript
// Frontend
async function performSignIn() {
  try {
    const nonce = await fetch('/api/auth/nonce').then(r => r.text());
    const { jwt } = await signIn({
      rpOrigin: window.location.origin,
      nonce,
      claims: { required: ['did'], optional: ['email', 'name'] },
    });
    const resp = await fetch('/api/auth/mid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt }),
    });
    const data = await resp.json();
    if (!resp.ok) handleBackendError(data.error);
    else handleSuccess(data);
  } catch (err) {
    if (err instanceof SignInError) handleSignInError(err);
    else { reportToSentry(err); showError('Something went wrong.'); }
  }
}

function handleSignInError(err) {
  const ux = {
    user_denied:               { silent: true },
    upsell_canceled:           { message: 'Sign in with MATA requires installing it first.' },
    timeout:                   { message: 'Sign-in took too long. Click Sign In to try again.' },
    wallet_unavailable:        { message: 'Your MATA wallet isn\'t ready. Open MATA, unlock, then click again.' },
    required_claim_unavailable:{ message: `MATA needs more info from your profile: ${err.message}.` },
    no_wallet_installed:       { message: 'MATA isn\'t installed.' },
    invalid_request:           { message: 'Something went wrong on our end.', log: true },
    origin_mismatch:           { message: 'Something went wrong on our end.', log: true },
    internal_error:            { message: 'Something went wrong.', log: true },
  }[err.code] ?? { message: 'Unknown error.', log: true };

  if (ux.log) reportToSentry(err);
  if (!ux.silent) showError(ux.message);
}

function handleBackendError(code) {
  const ux = {
    session_expired:   { message: 'Session expired. Click Sign In again.' },
    auth_failed:       { message: 'Authentication failed.' },
    identity_mismatch: { message: 'We couldn\'t verify your identity. Contact support.' },
  }[code] ?? { message: 'Authentication failed.' };
  showError(ux.message);
}
```
