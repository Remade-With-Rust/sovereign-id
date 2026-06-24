# Sovereign ID — Hello World Demo

A runnable end-to-end demo of [MATA Sovereign ID](https://github.com/Remade-With-Rust/sovereign-id) (mID) — the permissionless self-issued identity protocol.

Click a button, get a verified DID + claims back. **No MATA extension or native app required** — the demo includes a dev-mode mock wallet so you can see the full flow without any platform install.

## Quick start (local)

```bash
cd examples/hello-world
npm install
npm start
```

Then open <http://localhost:3000/>.

## Deploy to fly.io

This package ships a [`Dockerfile`](./Dockerfile) + [`fly.toml`](./fly.toml)
ready for fly.io. To deploy:

```bash
cd examples/hello-world

# First time only — picks app name, region, sets up the app:
fly launch --copy-config --no-deploy

# Every deploy after that:
fly deploy
```

The default `fly.toml` config:

- 256 MB shared-CPU machine — plenty for the demo (nonces + users are
  in-memory).
- `auto_stop_machines` enabled so the machine sleeps when idle and
  wakes on first request (no idle cost).
- HTTPS-only with automatic cert provisioning.
- Health check hits `/api/whoami` every 15s.

After `fly deploy` succeeds, your demo is live at
`https://<app-name>.fly.dev/`. The SDK's install upsell now exercises
its real Chrome Web Store install loop against an HTTPS origin (which
is required for non-`localhost` mID sign-ins).

You'll see two buttons:

- **"Sign in with Sovereign ID"** — uses the real `@matanetwork/sovereign-id` page-side SDK. Probes for the MATA extension first; falls back to the `mata-mid://` native-app deep link. With no MATA wallet installed, the SDK surfaces an **install upsell modal** (links to the Chrome Web Store, polls for the extension, auto-resumes the sign-in once installed). Both the install CTA and the "create your account" link inside the modal are stamped with `?ref=<rpHostname>` so signups that flow through the upsell are attributed back to the originating RP — see [Referral attribution](#referral-attribution) below. Click "Cancel" on the modal to reject with `ERR_UPSELL_CANCELED` instead.
- **"Dev-mock sign-in (no extension required)"** — uses an in-process mock wallet that mints a real, cryptographically-valid JWT against an in-memory ECDSA P-256 keypair. The backend verifies it with the same `@matanetwork/sovereign-id-verify` package an RP would ship to production.

After clicking, the **Wire trace** card shows every protocol-level event:

1. `GET /api/nonce` returns a single-use random string.
2. Either the SDK or the dev-mock endpoint produces a signed JWT.
3. `POST /api/verify` runs the five-step verification.
4. Backend anchors `(did, genesis_roster_hash, current_version)` in its in-memory user table.

The **Status** card then shows the verified DID, claims, roster version, and whether this was a first sign-in or a return visit.

## What's actually happening

```
Browser                       /api/nonce                  /api/verify
   │                              │                           │
   ├──── GET /api/nonce ──────────►                           │
   │◄──── nonce-abc123 ───────────┤                           │
   │                              │                           │
   ├──── (sign with wallet) ──────►  [Dev-mock OR SDK path]   │
   │     produces JWT signed       │                           │
   │     by genesis P-256 key      │                           │
   │                              │                           │
   ├──── POST /api/verify ────────────────────────────────────►
   │                                                          │
   │                                              ┌───────────┴───────────┐
   │                                              │ verifyResponse(jwt)   │
   │                                              │  1. Split JWS         │
   │                                              │  2. Validate header   │
   │                                              │  3. Genesis sig       │
   │                                              │  4. Roster chain      │
   │                                              │  5. Head VM in roster │
   │                                              │  6. JWS outer sig     │
   │                                              │  + audience match     │
   │                                              │  + nonce match        │
   │                                              │  + iat/exp window     │
   │                                              └───────────┬───────────┘
   │                                                          │
   │◄────── { verified: true, did, claims, version } ─────────┤
   │                                                          │
   └─ Status card shows the verified result                   │
```

**Crucially, zero HTTP requests go to MATA infrastructure during any of this.** Per ADR 0005, RPs verify mID tokens entirely against the cryptographic material embedded in the JWT itself.

## Endpoints

The Express RP backend exposes four routes:

| Method + path | Purpose |
|---|---|
| `GET /` | Serves the demo HTML page. |
| `GET /api/nonce` | Issues a single-use random nonce. The backend stores it; verification asserts the JWT echoes this exact value. |
| `POST /api/verify` | Body: `{ jwt }`. Runs `verifyResponse` and returns the verified shape (or a `VerifyError` code). Maintains an in-memory `users` table with first-sight anchoring + rollback detection. |
| `POST /api/dev/mock-jwt` | **DEV-ONLY.** Body: `{ rpOrigin, nonce, claims, profile }`. The mock wallet generates a JWT using an in-process P-256 keypair. In production, this signing happens inside the user's wallet. |
| `GET /api/whoami` | Debug endpoint: returns the demo's RP origin, mock wallet's DID, and the in-memory `users` table. Useful for inspecting state between sign-ins. |

## Files

```
examples/hello-world/
├── package.json
├── README.md                       ← you are here
├── src/
│   ├── server.js                   ← Express RP backend
│   └── wallet-mock.js              ← in-process mock wallet (dev-only)
└── public/
    ├── index.html                  ← demo page
    ├── style.css
    └── app.js                      ← client controller (imports SDK from /sdk/)
```

The browser-side `app.js` imports `@matanetwork/sovereign-id` from `/sdk/index.js`, which the server proxies to the actual SDK source at `../mata-sovereign-id-sdk/src/`. In a real RP build, you'd bundle the SDK via Webpack / Vite / esbuild — this no-bundler path keeps the demo simple.

## What this demonstrates

1. **The `@matanetwork/sovereign-id` SDK API.** Real call site: `await signIn({ rpOrigin, nonce, claims })`.
2. **The protocol wire format.** The trace shows what crosses the boundary — nonce request, JWT, verify response.
3. **The `@matanetwork/sovereign-id-verify` integration.** Real call site: `await verifyResponse(jwt, { expectedAudience, expectedNonce, nowUnixSecs })`.
4. **First-sight anchoring + rollback detection.** The backend keys users on `(did, genesis_roster_hash)` and rejects any later sign-in that would lower `currentVersion`. Click the dev-mock button twice in a row to see "is_returning_user" flip to `true`.
5. **The honest provenance model.** Every claim shows `attested_by: "self"` — MATA never signed them; the user did via their device.

## What this does NOT demonstrate

- **The real MATA extension or native app signing.** That requires the extension/native deep-platform integration to ship (separate roadmap items per [phase 1 sso_permissionless_mission.md](../../docs/plans/phase%201%20sso_permissionless_mission.md)).
- **The consent screen UI.** The mock wallet auto-approves; the real wallet shows the user `MidConsentScreen` first.
- **The similar-domain phishing detection.** Mock wallet doesn't run `mid-detect` — that lives in the wallet client.
- **The biometric gate.** That's the native app's Face ID / Touch ID prompt.

The protocol layer is all real; the missing pieces above are UX surfaces that need the wallet client to be running, not the verifier.

## Verifying it works

While the server is running, exercise the full loop from a shell:

```bash
# 1. Issue a nonce
NONCE=$(curl -s http://localhost:3000/api/nonce)
echo "nonce: $NONCE"

# 2. Mock the wallet to mint a JWT
JWT=$(curl -s -X POST http://localhost:3000/api/dev/mock-jwt \
  -H "Content-Type: application/json" \
  -d "{\"rpOrigin\":\"http://localhost:3000\",\"nonce\":\"$NONCE\",\"claims\":{\"required\":[\"did\"],\"optional\":[\"email\",\"name\"]},\"profile\":{\"email\":\"tim@example.com\",\"name\":\"Tim\"}}" \
  | jq -r .jwt)

# 3. Verify on the backend
curl -s -X POST http://localhost:3000/api/verify \
  -H "Content-Type: application/json" \
  -d "{\"jwt\":\"$JWT\"}" | jq
```

Expected output:

```json
{
  "verified": true,
  "did": "did:mata:xyL1eaX2xPX9...Tvtp",
  "currentVersion": 1,
  "genesisRosterHash": "749da4db1b96...",
  "claims": {
    "did":   { "value": "did:mata:xyL1...", "attested_by": "self" },
    "email": { "value": "tim@example.com", "attested_by": "self", "verified_at_signup": true },
    "name":  { "value": "Tim", "attested_by": "self" }
  },
  "iat": 1780599117,
  "exp": 1780602717,
  "is_returning_user": false
}
```

## Resume after reload

If a user installs MATA mid-flow and reloads the RP page (because
Chrome's "Extension installed" toast nudges them to, or because they
do it manually), the install upsell modal is gone — the in-flight
`signIn()` promise has already died with the page.

The SDK persists enough state across the reload that a single call to
`resumePendingSignIn()` at app boot picks the flow back up:

```js
import { signIn, resumePendingSignIn } from '@matanetwork/sovereign-id';

// On boot — typically before rendering, so the user doesn't see a
// flicker through the logged-out state.
resumePendingSignIn().then((result) => {
  if (result) {
    handleSignedIn(result.jwt);
  }
  // null → no resume pending, proceed with the normal boot path.
});

// On button click — unchanged.
signInButton.addEventListener('click', () => signIn(request));
```

The demo wires this in [public/app.js](public/app.js) — try the flow
by clicking "Sign in with Sovereign ID" without the extension
installed, clicking the install button in the upsell, installing the
extension, then reloading this tab. The Wire trace card shows
`↻ Resumed sign-in after reload`.

Mechanics:

- Stashed in `sessionStorage` under `mata_mid_pending_signin` so it's
  scoped to the current tab and cleared on tab close.
- TTL equals the original request's `timeoutMs` (default 2 min); stale
  entries are silently dropped.
- Cleared on success, on cancel, on any non-`ERR_NO_WALLET_INSTALLED`
  error, and on a subsequent `signIn()` that reaches the extension
  directly (which supersedes the pending resume).

## Referral attribution

When the upsell modal opens, both outbound links carry a `?ref=<code>`
parameter so signups that result from your sign-in button get
attributed back to your domain:

- **Install CTA** (e.g. Chrome Web Store) — stamped with the ref, kept
  in place for future store-side honoring (Chrome doesn't forward
  store-URL params to extensions today, but the ref is harmless).
- **"Create your account" link** inside the modal — links to
  `https://my.mata.network/signup?ref=<code>`. The MATA signup flow's
  existing welcome view captures this into the `mata_ref` cookie (30
  days, `SameSite=Lax`) and the signup form forwards it to Supabase as
  the `referral_code` field.

By default the SDK derives the ref from your RP origin's hostname —
calling `signIn({ rpOrigin: "https://acme.com", ... })` produces
`?ref=acme.com` automatically. Override or disable it:

```js
await signIn(
  { rpOrigin, nonce, claims },
  {
    ref: 'acme-launch-2026',  // custom string — overrides the default
    // ref: null,             // opt out of attribution entirely
  }
);
```

This follows the same `?ref=<code>` convention MATA users already share
their personal referral links with (e.g.
`https://my.mata.network/?ref=alice`), so RP-attributed signups and
user-referred signups share a single attribution path downstream.

## License

MIT.
