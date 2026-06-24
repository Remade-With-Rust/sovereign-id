# @matanetwork/sovereign-id-verify

Node / Deno / Bun verifier for **MATA Sovereign ID** (mID) JWTs.

Runs the full four-step verification (genesis self-signature → roster chain → head VM check → JWS outer signature) entirely locally using Web Crypto API. **Zero runtime HTTP calls to MATA infrastructure** per ADR 0005.

## Install

```bash
npm install @matanetwork/sovereign-id-verify
```

Pair with the page-side SDK:

```bash
npm install @matanetwork/sovereign-id
```

## Quick start (Express)

```javascript
import express from 'express';
import { verifyResponse, checkRollback, VerifyError } from '@matanetwork/sovereign-id-verify';

const app = express();
app.use(express.json());

app.post('/api/auth/mid', async (req, res) => {
  const { jwt } = req.body;
  if (typeof jwt !== 'string') {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const sessionNonce = await pullNonceFromSession(req);

  try {
    const verified = await verifyResponse(jwt, {
      expectedAudience: 'https://acme.com',
      expectedNonce: sessionNonce,
      nowUnixSecs: Math.floor(Date.now() / 1000),
      maxIatSkewSecs: 120, // optional, default 120
    });

    // Optional rollback check — defend against stolen-device replay
    // of a pre-revocation roster envelope.
    const lastSeen = await db.lookupLastSeenVersion(verified.did);
    checkRollback(verified, lastSeen);

    // verified.did              — stable user identifier
    // verified.claims           — disclosed values
    // verified.currentVersion   — head roster version (cache as last_seen)
    // verified.genesisRosterHash — anchor on first sight

    await upsertUserAndIssueSession(req, res, verified);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof VerifyError) {
      return res.status(401).json({ error: err.code });
    }
    throw err;
  }
});

app.listen(3000);
```

## API reference

### `verifyResponse(jwt, config)`

Runs the full four-step verification.

**`config`:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `expectedAudience` | `string` | yes | Must equal the JWT's `aud` claim. Your RP's bare origin. |
| `expectedNonce` | `string` | yes | The single-use nonce you issued for this sign-in. |
| `nowUnixSecs` | `number` | yes | Current wall-clock time. `Math.floor(Date.now() / 1000)`. |
| `maxIatSkewSecs` | `number` | no | Default `120`. Tokens with `iat > now + skew` are rejected. |

**Returns** `Promise<VerifiedSovereignId>`:

```typescript
interface VerifiedSovereignId {
  did: string;              // stable user ID
  genesisRosterHash: string; // hex sha256, anchor on first sight
  currentVersion: number;   // head roster version
  claims: Record<string, ClaimValue>;
  iat: number;
  exp: number;
  aud: string;
}
```

**Throws** `VerifyError` with `.code` matching the Rust `mid-verify::VerifyError` variants:

| Code | When |
|---|---|
| `invalid_jws_shape` | JWT didn't split into 3 dot-separated parts. |
| `base64_decode` | A segment failed base64url decoding. |
| `invalid_jws_header` | Header isn't `{"alg":"ES256","typ":"JWT"}`. |
| `payload_json` | Payload bytes weren't valid JSON. |
| `audience_mismatch` | `aud` ≠ `expectedAudience`. |
| `nonce_mismatch` | `nonce` ≠ `expectedNonce`. |
| `expired` | `now >= exp`. |
| `not_yet_valid` | `iat > now + skew`. |
| `malformed_did` | DID didn't decode to a valid P-256 pubkey. |
| `malformed_vm_pubkey` | VM `publicKeyMultibase` decode failed. |
| `signature_wrong_length` | Signature wasn't 64 bytes. |
| `genesis_signature_invalid` | Genesis self-signature didn't verify. |
| `chain_signer_not_in_prior_roster` | Chain entry signed by unknown key. |
| `chain_signature_invalid` | Chain entry signature didn't verify. |
| `chain_version_not_monotonic` | Chain versions didn't strictly increase. |
| `current_vm_not_in_head_roster` | Signing device has been revoked. |
| `jwt_signature_invalid` | JWS outer signature didn't verify. |

### `checkRollback(verified, lastSeenVersion)`

Optional rollback check. Pass the highest version your DB has seen for `verified.did`; the function throws `VerifyError` with `code: 'rollback_detected'` if the current is lower. No-op if `lastSeenVersion` is `null` / `undefined` (DID hasn't been seen before).

```javascript
const lastSeen = await db.lookupLastSeenVersion(verified.did);
checkRollback(verified, lastSeen);
// proceed: upsert user with max(last_seen, current_version)
```

## Anchoring on first sight

When you see a DID for the first time, record `(did, genesisRosterHash, currentVersion)`. On subsequent sign-ins:

1. The same DID MUST produce the same `genesisRosterHash` (different = attacker spoofing).
2. `currentVersion >= last_seen_version` (lower = rollback).

```sql
CREATE TABLE users (
    did TEXT PRIMARY KEY,
    genesis_roster_hash TEXT NOT NULL,
    last_seen_roster_version BIGINT NOT NULL,
    ...
);

INSERT INTO users (did, genesis_roster_hash, last_seen_roster_version, ...)
VALUES ($1, $2, $3, ...)
ON CONFLICT (did) DO UPDATE
SET last_seen_roster_version = GREATEST(users.last_seen_roster_version, EXCLUDED.last_seen_roster_version),
    ...
WHERE users.genesis_roster_hash = EXCLUDED.genesis_roster_hash;
```

The `WHERE` predicate enforces "a DID's genesis state is immutable" — if anyone tries to upsert with a different `genesis_roster_hash`, the update is silently skipped (and you can alert on it).

## Why this is a separate package from `@matanetwork/sovereign-id`

- **Bundle size.** The frontend SDK has zero crypto dependencies; the verifier needs Web Crypto API + base58 + DER decoding. Splitting keeps the page-side bundle tiny.
- **Trust boundary.** The verifier runs on YOUR backend — RPs review it carefully before integration. Auditors find one focused package, not a dual-use module.

## License

MIT
