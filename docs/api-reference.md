# API reference

Every public surface in `@matanetwork/sovereign-id` and
`@matanetwork/sovereign-id-verify`, with TypeScript signatures and behavior
notes.

## `@matanetwork/sovereign-id` (page-side SDK)

### `signIn(request, options?)`

Request a sign-in. Probes for the extension; falls back to the
native-app deep link; falls back to the install upsell modal; resumes
once the user installs.

```typescript
function signIn(
  request: SignInRequest,
  options?: SignInOptions
): Promise<SignInSuccess>;
```

#### `SignInRequest`

| Field | Type | Required | Notes |
|---|---|---|---|
| `rpOrigin` | `string` | yes | Your bare origin, e.g. `"https://acme.com"`. Becomes the JWT's `aud`. |
| `nonce` | `string` | yes | Single-use random string from your backend. |
| `claims.required` | `string[]` | yes | Claim keys the user MUST approve. Almost always `["did"]`. |
| `claims.optional` | `string[]` | no | Claim keys the user can include or skip. |
| `claims.custom` | `Record<string, CustomClaim>` | no | Arbitrary keys from the user's profile_kv. |

`CustomClaim`:

```typescript
interface CustomClaim {
  optional: true;  // always true in v0 — custom claims can't be required
  description?: string;
}
```

#### Standard claim catalog (v1)

| Key | Type | Notes |
|---|---|---|
| `did` | string | Always available. The user's stable identifier. |
| `email` | string | User-supplied; `verified_at_signup` indicates OTP completion. |
| `name` | string | User's chosen display name. |
| `created_at` | u64 | Unix seconds when the user's DID was first minted. |
| `paired_devices_count` | u32 | Number of devices in the user's roster. |
| `level_rating.trust` | u32 | 0–100 trust score; carries `computed_at` + `formula_version`. |
| `level_rating.security` | u32 | 0–100. |
| `level_rating.incentive` | u32 | 0–100. |

#### `SignInOptions`

| Field | Type | Default | Notes |
|---|---|---|---|
| `timeoutMs` | `number` | `120000` | Hard request timeout. The user has this long to approve consent. |
| `nativeAppCallback` | `string` | `window.location.href` | URL the native app's callback redirects to. |
| `installUpsell` | `boolean` | `true` | When `false`, throws `ERR_NO_WALLET_INSTALLED` raw instead of showing the modal. |
| `ref` | `string \| null` | hostname of `rpOrigin` | Referral code stamped onto the upsell's outbound links. Pass `null` to opt out. |

#### `SignInSuccess`

```typescript
interface SignInSuccess {
  jwt: string;
  surface: 'extension' | 'native_app';
}
```

`surface` tells you which path produced the JWT. Useful for analytics
and for surface-specific UX (e.g. logging "user has the desktop app").

#### Throws

`SignInError` — see [error handling](./error-handling.md) for the
complete code list.

### `resumePendingSignIn()`

```typescript
function resumePendingSignIn(): Promise<SignInSuccess | null>;
```

Call once at app boot. Resumes an interrupted sign-in (the install
upsell stashed state, then the user reloaded).

Returns:

- **`SignInSuccess`** — stash was present, extension is now installed, sign-in completed.
- **`null`** — no stash, or stale stash, or extension still missing. Treat this as "nothing to resume; proceed with normal boot."

Throws `SignInError` only when a stash exists AND the extension is
present AND the resumed sign-in itself fails (user denied, timeout,
etc.) — same error shape as `signIn()`.

The stash lives in `sessionStorage.mata_mid_pending_signin`, scoped
to the current tab. TTL equals the original request's `timeoutMs`
(default 2 min); stale entries are silently dropped.

### `hasExtension()`

```typescript
function hasExtension(): boolean;
```

Returns `true` when the MATA browser extension is installed AND its
content script has injected `window.__mata_mid__` on the current page.

> **Race-condition note.** The content script runs at `document_idle`.
> RPs that call `signIn()` synchronously from `<head>` may probe
> before the script is injected. Call after `DOMContentLoaded` (or
> after a user gesture) to avoid the false negative.

### `showInstallUpsell(options)`

```typescript
function showInstallUpsell(
  options: InstallUpsellOptions
): Promise<'installed' | 'canceled'>;
```

Manually render the install upsell modal. Exposed for RPs who set
`installUpsell: false` and want to invoke the modal on their own
conditions.

`InstallUpsellOptions`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `rpOrigin` | `string` | — | Required. Shown prominently as the requesting RP. |
| `hasExtensionFn` | `() => boolean` | `hasExtension` | IoC hook for testing. |
| `cta` | `InstallCta` | `pickInstallCta()` | Override the auto-picked CTA. |
| `pollIntervalMs` | `number` | `1000` | How often the modal probes for the extension. |
| `ref` | `string \| null` | hostname of `rpOrigin` | Referral code. |

### `pickInstallCta()`

```typescript
function pickInstallCta(): InstallCta;
```

Returns the right install CTA `{label, url, hint}` for the user's
browser/OS. Exposed so RPs building their own upsell UI use the same
recommendation engine.

### `defaultRefFromOrigin(rpOrigin)`

```typescript
function defaultRefFromOrigin(rpOrigin: string): string | null;
```

Extracts the bare hostname from an RP origin. Returns `null` for
malformed input. Exposed so RPs can preview the attribution code
they'll get.

### `clearPendingSignIn()`

```typescript
function clearPendingSignIn(): void;
```

Imperatively drop the resume stash. Use when you've navigated to a
different sign-in flow that supersedes the pending mID request.

### `SignInError`

```typescript
class SignInError extends Error {
  readonly code: ErrorCode;
}

type ErrorCode =
  | 'user_denied'
  | 'upsell_canceled'
  | 'no_wallet_installed'
  | 'invalid_request'
  | 'origin_mismatch'
  | 'wallet_unavailable'
  | 'required_claim_unavailable'
  | 'timeout'
  | 'internal_error';
```

Branch on `.code` — see [error handling](./error-handling.md) for the
recommended UX per code.

### Constants

```typescript
PROTOCOL_VERSION = 1;
WINDOW_MID_GLOBAL = '__mata_mid__';
MESSAGE_DISCRIMINATOR = '__mata_mid_v1';
URL_SCHEME = 'mata-mid';
FRAGMENT_KEY_RESPONSE = 'mid_response';

ERR_USER_DENIED = 'user_denied';
ERR_UPSELL_CANCELED = 'upsell_canceled';
ERR_NO_WALLET_INSTALLED = 'no_wallet_installed';
ERR_INVALID_REQUEST = 'invalid_request';
ERR_ORIGIN_MISMATCH = 'origin_mismatch';
ERR_WALLET_UNAVAILABLE = 'wallet_unavailable';
ERR_REQUIRED_CLAIM_UNAVAILABLE = 'required_claim_unavailable';
ERR_TIMEOUT = 'timeout';
ERR_INTERNAL = 'internal_error';
```

## `@matanetwork/sovereign-id-verify` (backend verifier)

### `verifyResponse(jwt, config)`

```typescript
function verifyResponse(
  jwt: string,
  config: VerifyConfig
): Promise<VerifiedResponse>;
```

Runs the four-step verification entirely locally:

1. **Genesis self-signature** — the embedded genesis roster must be signed by the key the DID encodes.
2. **Roster chain** — each chain entry must be signed by a verification method present in the prior roster.
3. **Head VM** — the JWT's `embedded_verification_method` must match a head-roster entry exactly, key included (an id-only match is rejected).
4. **JWS outer signature** — the JWT itself must be signed by that head VM.

`VerifyConfig`:

| Field | Type | Notes |
|---|---|---|
| `expectedAudience` | `string` | Must match the JWT's `aud`. |
| `expectedNonce` | `string` | Must match the JWT's `nonce`. |
| `nowUnixSecs` | `number` | Wall-clock for `iat`/`exp` checks. |
| `maxIatSkewSecs` | `number` | Default `120`. How far in the past `iat` can be. |

`VerifiedResponse`:

```typescript
interface VerifiedResponse {
  did: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  nonce: string;
  claims: Record<string, ClaimValue>;
  currentVersion: number;       // head roster version
  genesisRosterHash: string;    // hex SHA-256 of the canonical genesis bytes
  embeddedVerificationMethodId: string;
}

interface ClaimValue {
  value: unknown;
  attested_by: 'self';
  verified_at_signup?: boolean;
  computed_at?: number;
  formula_version?: string;
}
```

### `checkRollback(verified, lastSeenVersion)`

```typescript
function checkRollback(
  verified: VerifiedResponse,
  lastSeenVersion: number
): void;
```

Throws `VerifyError({code: 'rollback_detected'})` if `verified.currentVersion <
lastSeenVersion`. Call this against your stored last-seen version for
the user's DID to defend against rollback attacks (a stolen old JWT
re-issued to look fresh).

### `VerifyError`

```typescript
class VerifyError extends Error {
  readonly code: VerifyErrorCode;
}
```

Error codes are string variants of `mid-verify::VerifyError`. The
most common ones:

| Code | Cause |
|---|---|
| `signature_invalid` | JWS outer signature didn't verify against the head VM. |
| `signature_wrong_length` | JWS signature wasn't 64 bytes (likely malformed token). |
| `genesis_signature_invalid` | The embedded genesis envelope wasn't signed by the DID's key. |
| `roster_chain_signature_invalid` | A chain entry's signature didn't verify against its declared signer. |
| `head_vm_not_in_roster` | The JWT's `embedded_verification_method` isn't in the head roster — possibly a forged token. |
| `audience_mismatch` | The JWT's `aud` didn't match your `expectedAudience`. |
| `nonce_mismatch` | The JWT's `nonce` didn't match your `expectedNonce`. Replay or stale request. |
| `expired` | Now is past the JWT's `exp`. |
| `iat_skew_too_large` | The JWT's `iat` is too far in the past for your `maxIatSkewSecs` window. |
| `malformed_did` | The DID isn't a valid `did:mata:<base58btc>` form. |
| `rollback_detected` | (from `checkRollback`) The JWT's `currentVersion` is less than your stored value. |
| `payload_json` | Couldn't parse the JWT payload as JSON. |
| `header_invalid` | JWT header wasn't `{alg: "ES256", typ: "JWT"}`. |

See `packages/mid-verify/src/error.rs` for the complete authoritative
list — these strings are derived from the Rust `mid_verify::VerifyError`
enum at build time.
