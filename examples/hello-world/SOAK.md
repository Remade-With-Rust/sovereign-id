# mID Internal Soak Runbook

Phase 6. Walk through these scenarios in a real browser to surface
bugs that compile-time checks and unit tests can't catch — cross-
component handoffs, timing races, real Chrome API behavior under load.

## Preflight

Build status as of the most recent automated sweep:

| Surface                              | Status                          |
|--------------------------------------|---------------------------------|
| Workspace wasm32 (4 ship crates)     | clean                           |
| Workspace aarch64-darwin (ui/desktop/mobile) | clean                   |
| Protocol crate tests (12 crates)     | 257/257 passing                 |
| `@matanetwork/sovereign-id` SDK tests       | 37/37 passing                   |
| `@matanetwork/sovereign-id-verify` tests    | 13/13 passing                   |
| Chrome extension v2.2.5 build        | clean (popup 886 KB, bg 952 KB, content 395 KB) |

Re-run anytime:

```bash
# Native
cargo build -p desktop -p mobile -p ui --target aarch64-apple-darwin

# WASM ship crates
cargo build -p extension-popup -p extension-background -p extension-content -p web \
  --target wasm32-unknown-unknown

# Protocol tests
cargo test -p mid-issuer -p mid-verify -p mid-dispatcher -p mid-claims \
  -p mid-consent-types -p mid-level-ratings -p mid-detect -p mid-origin \
  -p mid-url-scheme -p mid-biometric -p kms-client -p kms-verifier \
  --target aarch64-apple-darwin

# JS packages
(cd packages/mata-sovereign-id-sdk && node --test tests/index.test.js)
(cd packages/mata-sovereign-id-verify && node --test tests/index.test.js)

# Chrome extension
(cd packages/extension && bash build.sh)
```

## Setup

1. **Build the extension** and load it unpacked:
   ```bash
   cd packages/extension && bash build.sh
   ```
   In Chrome: `chrome://extensions` → Developer mode → Load unpacked → `packages/extension/dist`.

2. **Boot the hello-world demo**:
   ```bash
   cd examples/hello-world && npm install && npm start
   ```
   Open <http://localhost:3000/>.

3. Open the Chrome DevTools Console for the demo tab **and** the extension's
   service-worker console (`chrome://extensions` → MATA → "Service worker").
   Leave both open through every scenario — most bugs surface there first.

## Scenarios

Each scenario lists precondition / steps / expected outcome / what to
watch for. "Watch for" is where soak finds real bugs — it's the place
silent failures hide.

### Scenario 1 — Happy path: extension present, first mID sign-in

**Precondition.** Extension installed and unlocked. Demo's "extension status"
strip says "✓ MATA extension detected."

**Steps.**
1. Click "Sign in with Sovereign ID."
2. Extension popup opens with the consent screen.
3. Approve.

**Expected.**
- Wire-trace card shows: nonce issued → SDK signIn → consent → JWT → `verified: true`.
- Status card shows the verified DID + claims + `Returning user: no — first sign-in`.
- Extension SW console shows `lazy-bootstrapped genesis envelope for did=did:mata:...`.

**Watch for.**
- The genesis bootstrap should fire **once per credential** — re-running this
  scenario shouldn't re-bootstrap (no second log line).
- JWT `iat` must be within ±120s of wall clock. Clock skew on the user's
  machine surfaces here as a verifier rejection.
- The popup's auto-close after submit should leave focus restored on the
  RP tab's sign-in button.

### Scenario 2 — Returning user

**Precondition.** Scenario 1 ran. Genesis already persisted under
`chrome.storage.local.mid_genesis_<user_id>`.

**Steps.**
1. Click "Sign in with Sovereign ID" again.
2. Approve consent again (or click "Always allow" the first time and skip
   this prompt).

**Expected.**
- Status card flips `Returning user` to `yes`.
- `currentVersion` stays at 1 (no roster mutation between sign-ins).
- `genesisRosterHash` matches the value from Scenario 1.

**Watch for.**
- If `genesisRosterHash` differs across runs the bootstrap is firing
  twice — that's a chrome.storage.local persistence bug. Check the SW
  console for the bootstrap log.
- If "Always allow" was clicked, the second sign-in must skip the consent
  popup entirely (silent auto-approve). Watch the wire trace for
  `consent → ...` — it should be absent or very fast.

### Scenario 3 — Rollback protection

**Precondition.** Genesis already persisted.

**Steps.**
1. From the SW console, manually overwrite a key:
   ```js
   chrome.storage.local.get('mid_genesis_' + (await chrome.runtime.getContextsOk()).user_id, console.log)
   ```
   (or use the chrome.storage panel in DevTools → Application → Storage).
2. Tamper the `did` field to a different string.
3. Click sign-in.

**Expected.**
- Sign-in rejects with `wallet_unavailable` / a DID mismatch message in
  the SW console:
  `persisted mID genesis DID (...) does not match current #root pubkey (...) — refusing to sign with mismatched key`

**Watch for.** This guard exists specifically to refuse signing with a
mismatched key — silent failures here would be a serious security
regression. The SW must log loudly.

### Scenario 4 — Consent denied

**Precondition.** Extension installed.

**Steps.**
1. Click sign-in.
2. On the consent popup, click "Deny."

**Expected.**
- Wire trace shows `Verification rejected: user_denied`.
- SDK throws `SignInError` with `.code === 'user_denied'`.
- Demo's status card stays in "Not signed in" state.

### Scenario 5 — Install upsell, install in new tab, return

**Precondition.** Extension **uninstalled**. Demo says "✗ MATA extension not
detected."

**Steps.**
1. Click "Sign in with Sovereign ID."
2. The native-app deep link fires (you'll see `mata-mid://...` in the
   address bar momentarily), times out at ~1.5s.
3. The install upsell modal appears with the install button and the
   "create your account" line.
4. Click the install button → opens the Chrome Web Store in a new tab.
5. Install MATA there. **Do not reload the demo tab.**
6. Return to the demo tab.

**Expected.**
- The modal's polling (every 1s) detects `window.__mata_mid__`.
- The modal closes itself; sign-in continues to the extension surface.

**Watch for.**
- Both outbound links in the modal must carry `?ref=localhost` (or
  whatever the demo's hostname is). Hover over them to confirm.
- Tab key inside the modal must cycle between Install / Continue /
  Cancel / signup link **only** — Tab MUST NOT escape into the demo
  tab's underlying buttons.
- Escape key must close the modal.
- After cancel or close, focus must return to the original sign-in button.

### Scenario 6 — Resume-after-reload

**Precondition.** Extension uninstalled. Demo tab open with the upsell modal
already displayed (run steps 1-4 of Scenario 5 first).

**Steps.**
1. Install the extension in the new tab.
2. **Reload the demo tab** (Cmd-R) BEFORE returning to it normally.
3. Watch the demo page on first paint.

**Expected.**
- Demo's wire trace shows `↻ Resumed sign-in after reload` automatically
  on page load.
- Sign-in completes against the extension; status card populates.
- `sessionStorage.mata_mid_pending_signin` is cleared by the time the
  status card renders (check via DevTools → Application → Storage).

**Watch for.**
- If the resume entry has a stale TTL (>2 min old by the time you
  reload), the demo should NOT show the resume trace — it should show
  a clean boot. Confirm by waiting >2 minutes before reloading.
- If the extension is uninstalled (user reloaded *without* installing),
  the resume must be a silent no-op AND leave the stash in place for
  a future reload. Verify by hitting reload again after install:
  resume should fire on the second reload.

### Scenario 7 — User cancels the upsell

**Precondition.** Extension uninstalled.

**Steps.**
1. Click sign-in → upsell modal appears.
2. Click "Cancel" (or press Escape).

**Expected.**
- SDK rejects with `SignInError` code `upsell_canceled`.
- `sessionStorage.mata_mid_pending_signin` is cleared.
- A subsequent reload does **not** auto-resume.

### Scenario 8 — Replay attack defense

**Steps.**
1. Run the curl sequence in [README.md § Verifying it works](README.md#verifying-it-works).
2. Re-issue the same JWT against `/api/verify`.

**Expected.**
- First verify returns `{ verified: true, ... }`.
- Second verify returns `{ error: "nonce_mismatch", ... }`.

**Watch for.** The nonce should be consumed on the first verify
(removed from the in-memory map). If a replay succeeds, the nonce
store is broken.

### Scenario 9 — Similar-domain warning

**Steps.**
1. Run Scenario 1 against `http://localhost:3000/` first to seed the
   consent store with a known domain.
2. Restart the demo on a similar-looking origin — e.g. by editing
   `/etc/hosts` to alias `lOcalhost` to 127.0.0.1, or by running the
   demo on a separate port and faking the hostname.
3. Click sign-in from the look-alike domain.

**Expected.**
- Consent popup shows the similar-domain banner with both hosts side
  by side.

**Watch for.** If the consent screen doesn't show the warning when
the domain is genuinely a typo, `mid_detect::detect_similar_domain`
isn't being called or its threshold is off.

### Scenario 10 — Concurrent sign-ins (two tabs)

**Steps.**
1. Open the demo in two tabs.
2. Click sign-in in tab A.
3. Before approving, switch to tab B and click sign-in there.

**Expected.**
- The consent popup in tab A's flow gets superseded — its `signIn()`
  promise should reject (handoff fires `Superseded`).
- Tab B's consent popup is the active one.

**Watch for.** If both tabs end up with consent screens that both
seem live, the consent handoff has a multi-pending bug. The handoff
is designed for one-at-a-time.

### Scenario 11 — Native app deep link (if you have the desktop app installed)

**Precondition.** Desktop app built with mata-mid URL scheme registered
(see `packages/desktop/Info.plist`). Extension **uninstalled** so the
SDK falls through to the deep link.

**Steps.**
1. Click sign-in.
2. macOS asks "Open MATA?" — confirm.
3. App launches; consent overlay appears.
4. Approve.

**Expected.**
- App opens `https://localhost:3000/#mid_response=...` in the default
  browser.
- The demo tab's `hashchange` handler picks up the response.

**Watch for.**
- If the deep link fires but no app is registered, the SDK should still
  fall through to the install upsell (1.5s detection window).
- On a slow machine, the 1.5s window can cause a false negative — the
  app DOES launch but the SDK already showed the upsell. If this
  happens regularly, the threshold needs raising.

## Runtime risks worth probing (the silent-failure surface)

These are places where compile-time checks pass but real-world
behavior can drift. Soak should explicitly poke at each.

| Risk | Where | How to probe |
|---|---|---|
| `chrome.storage.local` write quota / failure | `extension-background::mid::write_genesis_record` | Fill chrome.storage to ~5 MB before sign-in. Verify the genesis bootstrap surfaces a clear error rather than silently succeeding with no persistence. |
| Vault key locked mid-flow | `consents::read_store` returns Err — dispatcher's `try_auto_approve` swallows | Trigger a session-timer lock between page click and consent. Should force consent screen rather than crash. |
| Content-script race on fast-loading pages | `WINDOW_MID_GLOBAL` not yet injected when SDK probes | RP page that calls `signIn()` from `<head>` synchronously — SDK falls through to native-app deep-link path even though extension is installed. Mitigation: doc that RPs MUST call after `DOMContentLoaded`. |
| Clock skew between user device + RP backend | `mid-verify::verifyResponse` rejects with `iat`/`exp` outside window | Set the system clock 5 min into the future. Verifier should reject with a specific error code. |
| Native-app launch slower than 1.5s | `signInViaNativeApp::NO_APP_DETECT_MS` | Cold-launch the native app. SDK may falsely show upsell while the app DOES launch in the background. |
| Popup auto-close after consent | `extension-popup::mid_consent_route::on_decision → window.close()` | Some Chrome versions reject `window.close()` for non-window-opened popups. Verify the popup actually closes after submit. |
| Resume stash collisions across mID requests in same tab | `sessionStorage.mata_mid_pending_signin` | Trigger two upsells back-to-back without canceling the first (close the modal via JS rather than click). Second stash should overwrite — verify only one fires on reload. |
| Genesis hash drift between extension + desktop signs of the same user | both surfaces independently call `sign_genesis_roster(now_unix_secs)` | If a user signs in via extension first, then via desktop, do they produce DIFFERENT genesis hashes? They should — the persistence keys differ. The RP backend rejects this in `/api/verify` as `genesis_hash_mismatch`. Doc this for users who sign in across surfaces. |

## What "soak passes" means

Every numbered scenario produces the documented expected outcome
across two browser refreshes (cold + warm cache). No console errors
in either the page or SW console that aren't documented. Bundle sizes
stay within ±5% of the figures in the preflight table.

If anything in the "Watch for" column triggers, file an issue with:
- which scenario
- exact expected vs. observed
- screenshots of both consoles
- the contents of the relevant chrome.storage / sessionStorage entries
