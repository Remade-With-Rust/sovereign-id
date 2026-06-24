# Integration guide

Beyond the quickstart — the design decisions, edge cases, and
production hardening that take you from "demo works" to "users in
prod."

## Mental model

mID is **not** OAuth. Forget the `client_id` / `redirect_uri` /
`/token` choreography. The model is:

```
Page → wallet → JWT → your backend verifier → your session
```

The wallet runs entirely on the user's device. The JWT is
self-anchored — it bundles its own resolution data (genesis roster
envelope + roster chain + verification methods). Your backend
verifies it against cryptographic material in the token itself,
without any HTTP call to MATA.

What this means in practice:

- **No back-channel.** The JWT comes back from `signIn()` directly.
  Your `POST /api/auth/mid` is the only network round-trip needed.
- **No registration.** You don't sign up your RP with MATA. There's
  no portal, no API keys.
- **No metering.** Sign in as much as you want.

## Anchor on first sight + rollback detection

The DID alone is not enough to securely identify a user across
sessions. A user could lose their device and re-mint a fresh DID
under the same email; your backend would see them as a new person.
Conversely, an attacker with an old JWT could try to re-issue it
against a newer wallet state to pivot accounts.

Defend with **anchor on first sight**: at the first verify call for
a DID, persist `(did, genesis_roster_hash, current_version)`. On
every subsequent verify, assert:

1. `verified.genesisRosterHash === stored.genesis_roster_hash` — same
   genesis, same DID owner. Different hash → a new wallet trying to
   present as the same DID. Reject.
2. `verified.currentVersion >= stored.last_seen_version` — roster
   only moves forward. Lower version → rollback attempt. Reject.

```javascript
const existing = users.get(verified.did);
if (existing) {
  if (existing.genesis_roster_hash !== verified.genesisRosterHash) {
    throw { code: 'genesis_hash_mismatch' };
  }
  checkRollback(verified, existing.last_seen_version);  // from @matanetwork/sovereign-id-verify
}
users.set(verified.did, {
  genesis_roster_hash: verified.genesisRosterHash,
  last_seen_version: Math.max(existing?.last_seen_version ?? 0, verified.currentVersion),
});
```

`checkRollback()` is a one-liner helper exported by the verifier.

## Nonces

Each `signIn()` call needs a fresh single-use nonce from your
backend, embedded in the JWT for replay defense.

Production checklist:

- **Random.** `crypto.randomBytes(32).toString('hex')` or equivalent.
  Never derive from user input.
- **Single-use.** Delete the nonce from your store on the first
  verify call, success or failure.
- **Session-scoped.** Key nonces by session ID so two simultaneous
  sign-ins in different tabs don't collide.
- **TTL.** Expire after 10 minutes. The user's flow takes ~10
  seconds; the slack is for cases where they leave the consent
  screen open.

The hello-world demo uses an in-memory `Map` keyed by nonce. For
real apps, use your existing session store (Redis, Postgres
`auth_nonces`, etc.).

## Claims

Required vs. optional vs. custom:

- **`claims.required`**: denial blocks sign-in. Use this only for
  what your app structurally needs to function. `["did"]` is almost
  always the right answer.
- **`claims.optional`**: the user sees a toggle on the consent
  screen. They can include or exclude each one. Use for everything
  you'd like-to-have.
- **`claims.custom`**: keys outside the standard catalog. v0 wallets
  ignore these — they were specced as a forward-compat hook for v1.1
  profile-kv lookups.

The verifier's `verified.claims` is the post-consent set —
everything the user actually approved. Iterate it directly; missing
keys mean the user excluded that disclosure.

```javascript
const email = verified.claims.email?.value;       // may be undefined
const did = verified.claims.did.value;            // always present
const trust = verified.claims['level_rating.trust']?.value;
```

## Honest provenance

Every claim's `attested_by` is `'self'` in v1. The user signed it
with their own M5 device key — MATA never witnessed the value.

This shapes how you present claims downstream:

- **In UI**: avoid saying "verified email" without qualifying.
  `verified_at_signup: true` on the email claim only means the user
  completed OTP at signup — it's a historical fact, not a current
  attestation.
- **For compliance**: self-attested claims are roughly equivalent to
  a user filling out a form. They're not KYC-grade.
- **For analytics**: claim values are user-provided; treat them with
  the same trust level you'd give a `<form>` field.

v1.1 plans introduce `attested_by: 'third_party_vc'` for verifiable
credentials. The enum is open — your code branching on
`attested_by === 'self'` will continue to work.

## The install upsell — when no wallet is present

When neither the extension nor a native app responds, the SDK shows
the install upsell modal. The modal:

1. Surfaces the right install CTA for the user's browser/OS (Chrome
   Web Store on Chromium-family browsers; "coming soon" messaging on
   Firefox/Safari/mobile).
2. Polls for the extension every second. Once detected, auto-closes
   and the original `signIn()` promise resolves against the extension
   surface.
3. Carries `?ref=<your-domain>` on both outbound links so signups
   resulting from your sign-in button are attributed to you.

If you want full control over the upsell UI:

```javascript
signIn(request, { installUpsell: false });
// Then catch ERR_NO_WALLET_INSTALLED yourself and render
// whatever UI you want.

// Or use the helpers:
import { showInstallUpsell, pickInstallCta } from '@matanetwork/sovereign-id';
const cta = pickInstallCta();  // {label, url, hint} per browser
```

## Resume after reload

The install upsell flow has one tricky case: the user installs MATA
in another tab, and Chrome's "Extension installed" toast may nudge
them to reload the current tab. If they do, the modal is gone — the
in-flight `signIn()` promise dies with the page.

Fix: call `resumePendingSignIn()` at app boot. The SDK stashes the
original request in `sessionStorage` before opening the modal; the
resume call picks it back up the moment the page boots with the
extension now present.

```javascript
// Run as early as possible — typically before rendering your
// logged-out UI, so the user doesn't see a flicker.
resumePendingSignIn().then((result) => {
  if (result) handleSignedIn(result.jwt);
});
```

Lifecycle of the stash:

- Written when the install upsell opens.
- Cleared on success, on cancel, on any non-`ERR_NO_WALLET_INSTALLED` error.
- Cleared on a direct extension call (a fresh `signIn()` supersedes the resume).
- TTL = the original `timeoutMs` (default 2 min). Stale on `readPendingSignIn()`.

## Session model

After verify succeeds, you mint your own session. mID doesn't impose
a session format — use whatever you already have (HTTP-only cookies,
JWT, server session). The DID is your durable user identifier; map
it to your `users` row at first sight.

For SPAs:

```javascript
// After fetch('/api/auth/mid') succeeds:
const { did } = await resp.json();
sessionStorage.setItem('current_did', did);
// Your own session cookie is set HTTP-only by the backend response;
// you don't need to manage it client-side.
```

## Refresh / re-auth

The mID JWT is short-lived (~1 hour `exp`). For long-lived sessions,
mint your own refresh token in `mintSession()` and use that. You can
re-issue an mID JWT anytime by calling `signIn()` again — but most
RPs only need it at the initial auth.

If a user's session expires, just route them back to the sign-in
button. The extension's auto-approve path (if they clicked "Always
allow" the first time) makes the second sign-in silent.

## Cross-device

mID DIDs are device-portable via the user's roster chain. If the
user adds a second device, both can sign mID JWTs. From your
backend's perspective:

- **DID is stable.** Same value across devices.
- **`embeddedVerificationMethodId`** changes per device — the kid
  identifies which key signed THIS JWT.
- **`currentVersion`** increases when devices are added/revoked. Your
  rollback check (`currentVersion >= last_seen_version`) naturally
  handles this.

You generally don't care which device signed — just trust the DID.

## Edge cases

### User cancels the install upsell

`SignInError` with `.code === 'upsell_canceled'`. Distinct from
`user_denied` (which is "user clicked Deny on the consent screen")
so your analytics can separate "didn't install" from "installed but
said no."

### User has the extension but is locked

The extension's lock screen opens. `signIn()` resolves once they
unlock and approve consent — the SDK's 2-minute `timeoutMs` is the
window. If they take longer than that, you get `ERR_TIMEOUT`.

### User has the extension but no MATA account

The extension's `SignupScreen` directs them to `my.mata.network/signup`
(in a new tab). Your `signIn()` call will time out — there's no path
where they can complete signup AND return to your tab within the
2-minute window. Your UX should anticipate this: if you get `timeout`
right after a fresh install, show "Did you finish creating your MATA
account? Click sign-in again to retry."

### User signed up on a different device

The extension on Device B will see no local credentials. Same path as
above — they're directed to `my.mata.network` to sign in their
account on Device B, then can come back.

### Concurrent sign-ins in two tabs

The consent screen handoff is one-at-a-time. If a second `signIn()`
arrives before the first is approved, the first's promise rejects
with a "superseded" error and the popup re-renders for the second
request. Your UI handles this by showing the right state for the
currently-active tab.

### Origin spoofing

The wallet validates that the page's claimed `rpOrigin` matches the
actual tab origin. If a malicious page claims `rpOrigin:
'https://yourbank.com'` while running on `https://attacker.com`, the
extension rejects with `origin_mismatch` before showing the consent
screen.

### Custom claim keys the wallet doesn't know

`claims.custom` keys not in the standard catalog are silently ignored
by v0 wallets. The user doesn't see them on the consent screen, and
they don't appear in `verified.claims`. Don't depend on a custom key
being honored — gate it behind a try/check.

## Going to production

Checklist:

- [ ] Backend verifies every JWT (don't trust client-side claims).
- [ ] Nonces are single-use, session-scoped, with a TTL.
- [ ] Anchor on first sight: store `(did, genesis_roster_hash)`.
- [ ] Rollback check: `checkRollback(verified, stored.last_seen_version)`.
- [ ] Session minting: HTTP-only cookies, not the mID JWT itself.
- [ ] Clock-skew tolerance: `maxIatSkewSecs: 120` (default) is the
      battle-tested number.
- [ ] Error handling: branch on `SignInError.code` per the
      [error handling guide](./error-handling.md).
- [ ] Loading state during the consent flow (~2-10s).
- [ ] Fallback CTA when `installUpsell: false` and you get `ERR_NO_WALLET_INSTALLED`.
- [ ] Privacy policy mentions self-attested provenance for any
      profile data you display ("Email shown is provided by the
      user").
