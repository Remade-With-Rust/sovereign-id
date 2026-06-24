# Quickstart — 10-minute integration

End-to-end sign-in with MATA Sovereign ID. By the end of this page
you'll have:

- A page button that opens MATA, asks the user for consent, and gets
  back a JWT.
- A backend endpoint that verifies the JWT and returns the user's DID.
- A working session that maps `(did, genesis_roster_hash)` to your
  user table.

If anything here doesn't match what's in your repo, check the
[API reference](./api-reference.md) for the exact current shapes.

## 0. Install

```bash
npm install @matanetwork/sovereign-id @matanetwork/sovereign-id-verify
```

Both packages are pure ESM, zero runtime deps. Browser side is the
SDK; backend is the verifier.

## 1. Backend — issue a nonce + accept a verify call

Express example. Adapt to your framework — the contract is the same.

```javascript
import express from 'express';
import crypto from 'node:crypto';
import { verifyResponse, VerifyError } from '@matanetwork/sovereign-id-verify';

const app = express();
app.use(express.json());

// In production, key nonces by session ID. In-memory here for brevity.
const nonces = new Map();
// In production, this is your real users table.
const users = new Map();  // did -> { genesis_roster_hash, last_seen_version, email, name }

const RP_ORIGIN = 'https://acme.com';  // your bare origin, no trailing slash

app.get('/api/auth/nonce', (req, res) => {
  const nonce = crypto.randomBytes(32).toString('hex');
  nonces.set(nonce, { issued_at: Date.now() });
  // Single-use; expire after 10 minutes.
  setTimeout(() => nonces.delete(nonce), 10 * 60 * 1000);
  res.type('text/plain').send(nonce);
});

app.post('/api/auth/mid', async (req, res) => {
  const { jwt } = req.body;
  if (typeof jwt !== 'string') return res.status(400).json({ error: 'invalid_request' });

  // Find the nonce the user's session is holding. In a real app,
  // you'd read this off the session cookie.
  const nonce = mostRecentNonce();
  if (!nonce) return res.status(400).json({ error: 'no_nonce' });

  try {
    const verified = await verifyResponse(jwt, {
      expectedAudience: RP_ORIGIN,
      expectedNonce: nonce,
      nowUnixSecs: Math.floor(Date.now() / 1000),
      maxIatSkewSecs: 120,
    });

    nonces.delete(nonce);  // burn the nonce

    // First-sight anchoring + rollback detection.
    const existing = users.get(verified.did);
    if (existing && existing.genesis_roster_hash !== verified.genesisRosterHash) {
      return res.status(401).json({ error: 'genesis_hash_mismatch' });
    }
    if (existing && verified.currentVersion < existing.last_seen_version) {
      return res.status(401).json({ error: 'rollback_detected' });
    }

    users.set(verified.did, {
      genesis_roster_hash: verified.genesisRosterHash,
      last_seen_version: Math.max(existing?.last_seen_version ?? 0, verified.currentVersion),
      email: verified.claims.email?.value ?? existing?.email ?? null,
      name: verified.claims.name?.value ?? existing?.name ?? null,
    });

    // Mint your own session. Sample: HTTP-only cookie.
    res.cookie('session', mintSession(verified.did), { httpOnly: true, sameSite: 'lax' });
    res.json({ did: verified.did, claims: verified.claims });
  } catch (err) {
    if (err instanceof VerifyError) {
      return res.status(401).json({ error: err.code, message: err.message });
    }
    res.status(500).json({ error: 'internal_error' });
  }
});

function mostRecentNonce() {
  let best = null, bestT = 0;
  for (const [n, { issued_at }] of nonces) if (issued_at > bestT) { best = n; bestT = issued_at; }
  return best;
}

function mintSession(did) { return 'your-app-session-token-for-' + did; }

app.listen(3000);
```

What just happened:

1. **`/api/auth/nonce`** issues a single-use random string. Your
   frontend asks for it right before calling `signIn()`.
2. **`/api/auth/mid`** runs the four-step verification. On success,
   you get `{ did, claims, currentVersion, genesisRosterHash }`. The
   anchor-on-first-sight + rollback checks defend against key-swap
   and downgrade attacks.

## 2. Frontend — the sign-in button

```html
<button id="signin">Sign in with Sovereign ID</button>
```

```javascript
import { signIn, resumePendingSignIn, SignInError } from '@matanetwork/sovereign-id';

// On boot — resume if the user got interrupted by a page reload mid-install.
resumePendingSignIn().then(handleResult).catch(handleSignInError);

document.getElementById('signin').addEventListener('click', async () => {
  try {
    const nonce = await fetch('/api/auth/nonce').then(r => r.text());
    const result = await signIn({
      rpOrigin: window.location.origin,
      nonce,
      claims: {
        required: ['did'],
        optional: ['email', 'name', 'level_rating.trust'],
      },
    });
    await handleResult(result);
  } catch (err) {
    if (err instanceof SignInError) handleSignInError(err);
    else console.error('unexpected', err);
  }
});

async function handleResult(result) {
  if (!result) return;  // resumePendingSignIn returned null — nothing to do.
  const resp = await fetch('/api/auth/mid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jwt: result.jwt }),
  });
  if (resp.ok) {
    const { did } = await resp.json();
    console.log('signed in as', did);
    window.location.href = '/dashboard';
  }
}

function handleSignInError(err) {
  switch (err.code) {
    case 'user_denied':     return; // user clicked Deny on the consent screen
    case 'upsell_canceled': return; // user dismissed the install upsell
    case 'timeout':         return; // user took too long
    default: alert('Sign-in failed: ' + err.code);
  }
}
```

That's the complete frontend. The SDK handles:

- **Extension detection** via `window.__mata_mid__`.
- **Native app deep-link fallback** via `mata-mid://`.
- **Install upsell modal** when neither responds — Chrome Web Store
  link with `?ref=<your-domain>` for attribution.
- **Polling auto-detect** so the modal closes itself the moment the
  user installs MATA in another tab and returns.
- **Resume after page reload** — sessionStorage-backed; the
  `resumePendingSignIn()` call picks the flow back up after a
  Chrome-prompted reload.

## 3. Test it

Locally without any MATA install:

```bash
# Use our hello-world demo as a reference RP.
cd examples/hello-world
npm install && npm start
# Open http://localhost:3000 and click "Dev-mock sign-in".
```

This runs an in-process mock wallet that mints real ECDSA P-256 JWTs.
The same `verifyResponse` accepts them — the cryptography is real,
only the signer's UX is fake. Good for unit tests and CI.

With a real MATA install:

```bash
# Build + load the extension.
cd packages/extension && bash build.sh
# Then chrome://extensions → Developer mode → Load unpacked → packages/extension/dist
```

## 4. Capture the referral

The install upsell modal stamps `?ref=<your-domain>` onto both
outbound links by default. When a user clicks "create your account"
from the upsell, they land at `https://my.mata.network/signup?ref=acme.com`
and signup credits your domain in the existing `referral_code`
field. No extra configuration.

Override:

```javascript
signIn(request, { ref: 'acme-launch-2026' });  // custom code
signIn(request, { ref: null });                // opt out
```

## Next steps

- [Integration guide](./integration-guide.md) — session model, rollback detection, edge cases.
- [Error handling](./error-handling.md) — recommended UX for each error code.
- [API reference](./api-reference.md) — every option.
