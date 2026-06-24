# MATA Sovereign ID

**Permissionless, self-issued identity for the web.** Replace *"Sign in with Google"*
with *"Sign in with Sovereign ID"* — your users authenticate against keys they hold on
their own device. No client ID, no portal account, no MAU pricing, no runtime traffic to
MATA.

Verification is **self-contained**: a signed token carries everything needed to verify it
(genesis self-signature → roster chain → head version → JWS signature), so your backend
verifies it **entirely locally** — zero calls to MATA infrastructure, ever.

## Packages

| Package | Install | What it's for |
|---|---|---|
| [`@matanetwork/sovereign-id`](packages/sovereign-id) | `npm i @matanetwork/sovereign-id` | The browser SDK — the "Sign in with Sovereign ID" button + flow |
| [`@matanetwork/sovereign-id-verify`](packages/sovereign-id-verify) | `npm i @matanetwork/sovereign-id-verify` | Backend verifier (Node / Deno / Bun) — verify the signed sign-in response locally |
| [`@matanetwork/sign-verify`](packages/sign-verify) | `npm i @matanetwork/sign-verify` | Verify MATA signed **statements** (documents, IAMHUMAN posts) — the same local 4-step check |
| [`@matanetwork/sovereign-id-react`](packages/sovereign-id-react) | `npm i @matanetwork/sovereign-id-react` | React bindings — `<SignInButton>`, `useSignIn()` |

All four are **pure JavaScript, zero-dependency, MIT-licensed**, and make **no network
calls to MATA**.

## Quick start

```javascript
// Frontend — start a sign-in on a button click.
import { signIn, SignInError } from '@matanetwork/sovereign-id';

const nonce = await fetch('/api/auth/nonce').then(r => r.text());
const result = await signIn({
  rpOrigin: window.location.origin,
  nonce,
  claims: { required: ['did'], optional: ['email', 'name'] },
});
// result.token  — the signed JWT to send to your backend
```

```javascript
// Backend — verify it locally. No fetches to MATA.
import { verifyResponse } from '@matanetwork/sovereign-id-verify';

const verified = await verifyResponse(jwt, {
  expectedAudience: 'https://acme.com',
  expectedNonce: sessionNonce,
  nowUnixSecs: Math.floor(Date.now() / 1000),
});
// verified.did          — stable user identifier (the DID is its own public key)
// verified.claims       — disclosed values
// verified.currentVersion — head roster version, for rollback detection
```

## What you don't have to think about

| You don't need | Because |
|---|---|
| `client_id` / `client_secret` | mID has no RP registration step. |
| Redirect URI allowlist | The flow is in-page or via OS deep-link. |
| `/token` back-channel | The JWT comes back from `signIn()` directly. |
| JWKS endpoint / DID resolver calls | The token bundles its own resolution data; the DID *is* its public key. |
| MAU pricing or metering | None exists. |

## Documentation

- [**Quickstart**](docs/quickstart.md) — 10-minute end-to-end integration. Start here.
- [**Integration guide**](docs/integration-guide.md) — backend wiring, session model, rollback detection, edge cases.
- [**API reference**](docs/api-reference.md) — every public surface, with types.
- [**Error handling**](docs/error-handling.md) — every error code, when it fires, what UI to show.
- [**Protocol**](docs/protocol.md) — the wire format, for verifier authors and security reviewers.

## Example

A runnable [hello-world](examples/hello-world) Express app shows the full flow end-to-end,
including a dev-mock wallet path for testing without a real MATA install:

```bash
cd examples/hello-world
npm install && npm start   # open http://localhost:3000
```

## Building in Rust / WASM?

These JS packages reimplement the verification natively. If you're building in Rust (or
compiling to WASM), the underlying **mID crates** are open-sourced under
[**Remade-With-Rust**](https://github.com/orgs/Remade-With-Rust/repositories) — same
permissionless, self-contained model.

## License

Dual context, one license: **MIT**. See [LICENSE](LICENSE).
