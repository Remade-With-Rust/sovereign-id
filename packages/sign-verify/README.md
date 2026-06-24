# @matanetwork/sign-verify

Verify **MATA signed statements** in Node, Deno, or Bun — sign-arbitrary-content
tokens that prove a `did:mata` authored a document or a post.

A signed statement is the building block for:

- **Internal document signing** — offer letters, NDAs, contracts signed by a
  company or person's sovereign identity.
- **IAMHUMAN** — a PGP-equivalent for the open web: prove a *verified human*
  wrote a Reddit / X / forum post.

The token is **self-contained** — the signer's device roster and
proof-of-control travel inside it — so you verify **offline, with zero calls to
MATA infrastructure**. This is the JavaScript counterpart to the Rust
[`mata-sign`](../mata-sign) crate; the four cryptographic checks are identical
to [`@matanetwork/sovereign-id-verify`](../mata-sovereign-id-verify).

## Install

```sh
npm install @matanetwork/sign-verify
```

Requires Node ≥ 18 (uses the Web Crypto API + `node:crypto`).

## Usage

```js
import { verifyStatement, matchesContent, VerifyError } from '@matanetwork/sign-verify';

// `token` is the signed-statement string; `document` is the bytes/text you hold.
try {
  const v = await verifyStatement(token, {
    nowUnixSecs: Math.floor(Date.now() / 1000),
    expectedContext: 'iamhuman', // optional: pin the use case
    // expectedNonce: '…',        // optional: anti-replay
    // maxIatSkewSecs: 120,        // optional, default 120
  });

  // The signature proved WHO signed (v.did). Now confirm WHAT they signed:
  if (!matchesContent(v, document)) {
    throw new Error('content does not match the signature');
  }

  console.log(`Signed by ${v.did} — verified human ✓`);
} catch (err) {
  if (err instanceof VerifyError) {
    console.error(`rejected: ${err.code} — ${err.message}`);
  }
}
```

### Detached signatures — why two steps?

`verifyStatement` proves the token is authentic and tells you *who* signed and
*what hash* they committed to. It does **not** receive the content — signing is
**detached** (the token carries `SHA-256(content)`, not the bytes, so signing a
2 GB PDF costs the same as signing a tweet). You call `matchesContent` with the
bytes you already hold to bind *who-signed* to *what-was-signed*.

For short text (e.g. a forum post) the signer may inline a copy in
`v.preview` — convenient for display, but `matchesContent` against the real
content is still authoritative.

## API

### `verifyStatement(token, opts) → Promise<VerifiedStatement>`

| `opts` field        | type     | notes                                                        |
| ------------------- | -------- | ------------------------------------------------------------ |
| `nowUnixSecs`       | number   | **required** — verifier's wall clock (Unix seconds)          |
| `maxIatSkewSecs`    | number?  | allowed forward skew, default `120`                          |
| `expectedContext`   | string?  | if set, the statement's `context` must equal it exactly      |
| `expectedNonce`     | string?  | if set, the statement's `nonce` must equal it exactly        |

`VerifiedStatement`: `{ did, contentHash (hex), contentType, currentVersion, iat, exp, context, preview }`.

### `matchesContent(verified, content) → boolean`

Recompute `SHA-256(content)` and compare to the committed `contentHash`.
`content` may be a string, `Uint8Array`, `ArrayBuffer`, or `Buffer`.

### `VerifyError`

Thrown on any failure. `.code` is a stable snake_case string matching the Rust
check that failed (`genesis_signature_invalid`, `chain_signature_invalid`,
`current_vm_not_in_head_roster`, `jwt_signature_invalid`, `expired`,
`not_yet_valid`, `context_mismatch`, `nonce_mismatch`,
`malformed_content_hash`, `invalid_jws_shape`, …).

## What gets checked

1. **Genesis self-signature** — the genesis roster is signed by the key
   recoverable from the DID.
2. **Roster chain** — each device-roster mutation is signed by a key in the
   prior roster; versions strictly increase.
3. **Current VM in head** — the signing device is in the current roster (not
   revoked).
4. **JWS signature** — ES256 over the token, against that device's key.
5. **Freshness + binding** — `exp` / `iat` skew, optional `context` / `nonce`.

Then **you** call `matchesContent` to confirm the bytes.

## Wire-format stability

This is a `0.x` release. The wire format is shared with the Rust `mata-sign`
crate and is kept in lockstep by a **cross-implementation conformance test** —
the test suite verifies a real token produced by the Rust crate. The format is
**not yet frozen for 1.0**; until then, treat it as subject to change.

## License

MIT
