# MATA Sovereign ID (mID) — Developer Documentation

Permissionless, self-issued identity for the web. Replace `"Sign in
with Google"` with `"Sign in with Sovereign ID"` and your users
authenticate against keys they hold on their own device. No client
ID, no portal account, no MAU pricing, no runtime traffic to MATA.

## What you ship

**A single button.** Behind it, the `@matanetwork/sovereign-id` SDK probes
for the MATA browser extension or native app, dispatches the sign-in
request, and resolves with a signed JWT carrying:

- A stable DID — the user's identifier, deterministic across sessions
  and devices.
- The claims they consented to disclose (email, name, level ratings,
  custom keys).
- An embedded roster of verification methods + signatures the JWT
  brings with it.

Your backend hands the JWT to `@matanetwork/sovereign-id-verify`, which runs
the four-step verification entirely locally and returns
`{did, claims, currentVersion, genesisRosterHash, …}`. No fetches to
MATA infrastructure, ever.

## Reading order

1. [**Quickstart**](./quickstart.md) — 10-minute end-to-end integration. Read this first.
2. [**Integration guide**](./integration-guide.md) — backend wiring, session model, rollback detection, edge cases.
3. [**API reference**](./api-reference.md) — every public surface in `@matanetwork/sovereign-id` and `@matanetwork/sovereign-id-verify`, with types.
4. [**Error handling**](./error-handling.md) — every error code, when it fires, what UI to show.
5. [**Protocol**](./protocol.md) — the wire format, for verifier authors and security reviewers.

## Quick example

```javascript
import { signIn, resumePendingSignIn, SignInError } from '@matanetwork/sovereign-id';

// On page boot — resume an interrupted sign-in if one was stashed.
resumePendingSignIn().then(handleResult);

// On button click — start a fresh request.
document.getElementById('signin').addEventListener('click', async () => {
  try {
    const nonce = await fetch('/api/auth/nonce').then(r => r.text());
    const result = await signIn({
      rpOrigin: window.location.origin,
      nonce,
      claims: { required: ['did'], optional: ['email', 'name'] },
    });
    handleResult(result);
  } catch (err) {
    if (err instanceof SignInError) handleSignInError(err);
    else throw err;
  }
});
```

```javascript
// Your backend.
import { verifyResponse } from '@matanetwork/sovereign-id-verify';

const verified = await verifyResponse(jwt, {
  expectedAudience: 'https://acme.com',
  expectedNonce: sessionNonce,
  nowUnixSecs: Math.floor(Date.now() / 1000),
});

// verified.did — stable user identifier
// verified.claims — disclosed values
// verified.currentVersion — head roster version for rollback detection
```

## What you don't have to think about

| You don't need | Because |
|---|---|
| `client_id` / `client_secret` | mID has no RP registration step. |
| Redirect URI allowlist | The flow is in-page or via OS deep-link. |
| `/token` back-channel | The JWT comes back from `signIn()` directly. |
| JWKS endpoint refresh | The JWT bundles its own resolution data. |
| DID resolver HTTP calls | The DID is its own public key. |
| MAU pricing or metering | None exists. |

## Live demo

The [hello-world demo](https://github.com/Remade-With-Rust/sovereign-id/tree/main/examples/hello-world)
is a runnable Express app showing the full flow end-to-end, including
the dev-mock wallet path for testing without a real MATA install.

```bash
cd examples/hello-world
npm install && npm start
# open http://localhost:3000
```

## Support

- Issues: <https://github.com/Remade-With-Rust/sovereign-id/issues>
- Protocol questions: tag the issue with `protocol`.
- SDK / RP integration questions: tag with `sdk`.
