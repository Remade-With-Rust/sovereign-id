# Protocol

The mID wire format. For verifier authors (porting `@matanetwork/sovereign-id-verify`
to Go / Python / Ruby etc.), for security reviewers, and for anyone
who needs to know exactly what's on the wire.

The canonical reference is **ADR 0005** in
`docs/adr/0005-mid-protocol-v1-phase-0-spec-lockin.md` — this page
summarizes for developer-facing use.

## JWT structure

mID tokens are JWS compact-form JWTs (`header.payload.signature`)
with:

- **Algorithm**: `ES256` (ECDSA P-256 + SHA-256). No alternatives.
- **Signature form**: 64 bytes — `r || s`, low-s normalized (high-s
  signatures are rejected as a malleability defense).
- **Header**: exactly `{"alg":"ES256","typ":"JWT"}`. No `kid`, no
  `jwk`, no `x5c`.

Payload shape:

```typescript
{
  iss: string;       // the user's DID
  sub: string;       // same as iss for self-issued tokens
  aud: string;       // the RP's bare origin
  iat: number;       // Unix seconds
  exp: number;       // Unix seconds (~1 hour for v1)
  nonce: string;     // RP-supplied
  claims: Record<string, ClaimValue>;
  embedded_genesis_roster: EmbeddedGenesisRoster;
  embedded_roster_chain: EmbeddedRosterChainEntry[];
  embedded_verification_method: EmbeddedVerificationMethod;
}
```

The `embedded_*` fields are what makes the token self-anchored — the
verifier needs nothing beyond the JWT itself to resolve the DID and
verify every signature.

## DID format

```
did:mata:<base58btc>
```

The base58btc portion decodes to exactly **33 bytes** — a
SEC1-compressed P-256 public key (first byte `0x02` or `0x03`,
followed by 32 bytes of X coordinate).

**No multicodec prefix in v0.** A future version may prepend the
`p256-pub` multicodec varint `[0x80, 0x24]` for did:key wire
compatibility; that's an ADR'd change.

To recover the verifying key from a DID:

```javascript
import bs58 from 'bs58';
import { p256 } from '@noble/curves/p256';

const suffix = did.slice('did:mata:'.length);
const bytes = bs58.decode(suffix);
if (bytes.length !== 33) throw new Error('malformed_did');
const key = p256.ProjectivePoint.fromHex(bytes);  // SEC1 compressed
```

## Verification methods

A verification method = a public key bound to a DID. Same shape as
the W3C DID document `verificationMethod[]`:

```typescript
interface VerificationMethod {
  id: string;                      // "did:mata:abc#device-0"
  type: 'EcdsaSecp256r1VerificationKey2019';
  controller: string;              // "did:mata:abc"
  publicKeyMultibase: string;      // "z<base58btc>" — same 33-byte SEC1
}
```

The `id` suffix after `#` is the **kid** — a stable per-device
identifier. Single-device wallets use `"device-0"`; multi-device
wallets assign distinct kids per device.

The `embedded_verification_method` on the JWT is the key that signed
THIS token. Its `id` MUST appear in the head roster (the last entry
in `embedded_roster_chain`, or `embedded_genesis_roster` if the
chain is empty).

## Embedded genesis roster

Signed once at signup by the genesis device's #root key. Persisted
locally forever; bundled in every future mID JWT.

```typescript
interface EmbeddedGenesisRoster {
  version: 1;                                   // always 1 for genesis
  did: string;
  verification_methods: VerificationMethod[];   // one entry for single-device wallets
  signed_at: number;                            // Unix seconds
  self_signed_by_genesis_key: string;           // base64url(r || s), 64 bytes
}
```

Verification:

1. Recover the genesis pubkey from `did`.
2. Compute the canonical genesis bytes (see [Canonical bytes](#canonical-bytes)).
3. SHA-256 the canonical bytes → 32-byte prehash.
4. Verify `self_signed_by_genesis_key` against the prehash using the genesis pubkey.

If any step fails → `genesis_signature_invalid`.

The **genesis roster hash** is `SHA-256(canonical_bytes)` rendered as
lowercase hex. The verifier exposes this as
`verified.genesisRosterHash` — RPs key user-identity persistence on
`(did, genesis_roster_hash)`.

## Embedded roster chain

A chain of wallet-signed mutations, ordered earliest → latest. Each
entry recorded a device being added or revoked.

```typescript
interface EmbeddedRosterChainEntry {
  version: number;                             // > prior entry's version (or > 1 for the first)
  did: string;
  verification_methods: VerificationMethod[];  // the new full roster
  signed_at: number;
  signed_by_signer_in_prior_roster: string;    // base64url(r || s), 64 bytes
  signer_kid: string;                          // the kid in the PRIOR roster
}
```

Verification:

1. For the first entry, the prior roster is the genesis roster's
   `verification_methods`. For subsequent entries, the prior roster
   is `entries[i - 1].verification_methods`.
2. Find the VM in the prior roster whose `id` ends with `#<signer_kid>`.
3. Recover its pubkey from `publicKeyMultibase`.
4. Compute canonical chain-entry bytes (see [Canonical bytes](#canonical-bytes)).
5. SHA-256 → prehash → ECDSA verify against the recovered pubkey.

If any step fails → `roster_chain_signature_invalid`.

Versions must strictly increase. Genesis is version 1; the first
chain entry must be version 2.

**Head VM check.** After the chain is fully verified, the JWT's
`embedded_verification_method.id` must equal one of the VM `id`s in
the head roster (last entry's `verification_methods`, or the genesis
roster's if the chain is empty). Otherwise →
`head_vm_not_in_roster`.

## JWS outer signature

After all embedded checks pass, verify the JWT itself:

1. Recover the head VM's pubkey from `embedded_verification_method.publicKeyMultibase`.
2. Compute the JWS signing input: `${base64url(header_json)}.${base64url(payload_json)}` (ASCII bytes).
3. SHA-256 → 32-byte prehash.
4. base64url-decode the third JWS segment → 64-byte signature (`r || s`).
5. Reject if high-s (the verifier's malleability defense).
6. ECDSA-verify against the head VM's pubkey.

If any step fails → `signature_invalid` (or `signature_wrong_length`).

## Canonical bytes

Three canonical-bytes producers, all defined in
`packages/mid-issuer/src/canonical.rs` (single source of truth — both
the issuer and the verifier consume this module):

### Genesis canonical bytes

```
"mid-genesis-roster-v1"           # 21-byte ASCII domain separator
| u32_be(version)
| u32_be(did_len) | did_utf8
| u32_be(vm_count)
| for each VM:
|   u32_be(id_len) | id_utf8
|   u32_be(type_len) | type_utf8
|   u32_be(controller_len) | controller_utf8
|   u32_be(multibase_len) | multibase_utf8
| u64_be(signed_at)
```

`self_signed_by_genesis_key` is deliberately excluded — the canonical
form is computable before the signature exists.

### Chain entry canonical bytes

```
"mid-roster-chain-v1"             # 19-byte ASCII domain separator
| u32_be(version)
| u32_be(did_len) | did_utf8
| u32_be(vm_count) | <each VM, same as genesis>
| u64_be(signed_at)
| u32_be(signer_kid_len) | signer_kid_utf8
```

### JWS signing input

Standard JWS RFC 7515 §3: `${base64url(header)}.${base64url(payload)}`
as ASCII bytes. Nothing mID-specific — same canonical form every JWS
implementation produces.

## Verification flow summary

```
input: jwt
1. Split JWS                 → header_b64, payload_b64, signature_b64
2. Decode header             → assert {alg: "ES256", typ: "JWT"}
3. Decode payload             → MidJwtPayload
4. Genesis self-sig check    → using did's recovered key
5. Roster chain walk         → each entry's signature against prior roster
6. Head VM membership check  → embedded_verification_method.id in head roster
7. JWS outer sig check       → using head VM's recovered key
8. Audience match            → payload.aud === expectedAudience
9. Nonce match               → payload.nonce === expectedNonce
10. Time window check        → iat in [now - maxIatSkewSecs, now], exp > now
11. Output VerifiedResponse
```

Steps 1-7 are pure cryptography. Steps 8-10 are policy checks against
the verifier's `config`. The output bundles the post-consent claims
+ the head version + the genesis hash for anchor-on-first-sight.

## Wire-format stability

mID v1 wire shapes are locked by ADR 0005. Any breaking change
requires a follow-on ADR and a bumped `version` field in the genesis
envelope.

The `claims` shape is also stable — `ClaimValue` keys
(`value`, `attested_by`, `verified_at_signup`, `computed_at`,
`formula_version`) are wire-format facts. Future versions can ADD
keys but not RENAME or REMOVE existing ones.

The protocol version inside the native-app URL scheme
(`mata-mid://request?payload=<base64url-{ "version": 1, ... }>`) is
separately versioned — wallets reject unknown values.

## Implementing a verifier in a new language

Port `packages/mid-verify` directly. Required primitives:

- ECDSA P-256 signature verification with raw `r || s` input and
  externally-supplied SHA-256 prehash.
- SHA-256.
- base64url-decode (no padding).
- base58btc decode.
- JSON parse.
- Big-endian u32 / u64 serialization for canonical bytes.

No HTTP, no DNS, no any other network primitive.

The `@matanetwork/sovereign-id-verify` JS implementation is ~600 LOC
including types and error variants — a good size reference for what
a clean port looks like.

## Test vectors

The Rust `mid-issuer` and `mid-verify` test suites carry deterministic
fixtures you can use as cross-implementation test vectors:

- `packages/mid-issuer/src/bootstrap.rs::tests::sign_genesis_roster_signature_verifies_against_genesis_key`
- `packages/mid-verify/src/checks.rs` (all `verify_*` test cases)

For language-portable vectors (just hex-encoded inputs + expected
outcomes), see `packages/mid-verify/tests/fixtures/` in the workspace.
