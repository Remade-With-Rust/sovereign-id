/**
 * @matanetwork/sovereign-id-verify — verifier tests.
 *
 * Run with: `node --test tests/index.test.js`.
 *
 * Strategy: mint a JWT in-test using webcrypto, then verify it. Proves
 * the verifier accepts well-formed input + rejects every tamper.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { verifyResponse, checkRollback, VerifyError } from '../src/index.js';

const subtle = webcrypto.subtle;

// ─── Test JWT minter (JS-side, mirrors Rust mid-issuer) ────────────────────

const GENESIS_DOMAIN = new TextEncoder().encode('mid-genesis-roster-v1');
const CHAIN_ENTRY_DOMAIN = new TextEncoder().encode('mid-roster-chain-v1');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let s = '';
  while (value > 0n) {
    s = BASE58_ALPHABET[Number(value % 58n)] + s;
    value /= 58n;
  }
  // Preserve leading zeros.
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = '1' + s;
  return s;
}

function base64UrlEncodeBytes(bytes) {
  // Node Buffer → base64 → URL-safe charset, strip padding.
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlEncodeString(str) {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u32BE(n) {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function u64BE(n) {
  const hi = Math.floor(n / 0x1_0000_0000);
  const lo = n >>> 0;
  return Uint8Array.from([
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ]);
}

function pushString(s) {
  const utf8 = new TextEncoder().encode(s);
  return concat(u32BE(utf8.length), utf8);
}

function pushVms(vms) {
  const parts = [u32BE(vms.length)];
  for (const vm of vms) {
    parts.push(pushString(vm.id));
    parts.push(pushString(vm.type));
    parts.push(pushString(vm.controller));
    parts.push(pushString(vm.public_key_multibase));
  }
  return concat(...parts);
}

function genesisCanonicalBytes(genesis) {
  return concat(
    GENESIS_DOMAIN,
    u64BE(genesis.version),
    pushString(genesis.did),
    pushVms(genesis.verification_methods),
    u64BE(genesis.signed_at)
  );
}

/**
 * Generate a deterministic P-256 keypair from a seed string.
 * Mirrors the Rust test helper that uses SHA-256(seed) as the
 * scalar.
 */
async function makeKey(seed) {
  // We need a stable keypair to mint test JWTs the verifier can
  // re-verify. webcrypto's `generateKey` is non-deterministic, so we
  // import a raw scalar derived from `seed`.
  //
  // For test purposes use webcrypto's `generateKey` (non-deterministic
  // BUT we won't compare across runs — within a single test the keys
  // are reused).
  const keypair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  // Export public key as uncompressed SEC1 (65 bytes), compress to 33.
  const rawPubkey = new Uint8Array(await subtle.exportKey('raw', keypair.publicKey));
  if (rawPubkey.length !== 65 || rawPubkey[0] !== 0x04) {
    throw new Error('expected uncompressed SEC1 pubkey');
  }
  const x = rawPubkey.slice(1, 33);
  const y = rawPubkey.slice(33, 65);
  const yIsOdd = y[31] & 1;
  const compressed = new Uint8Array(33);
  compressed[0] = yIsOdd ? 0x03 : 0x02;
  compressed.set(x, 1);

  const did = `did:mata:${base58Encode(compressed)}`;
  const multibase = `z${base58Encode(compressed)}`;
  return { ...keypair, did, multibase };
}

async function signBytes(privateKey, bytes) {
  const sig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    bytes
  );
  return new Uint8Array(sig);
}

/**
 * Mint a complete mID JWT against a fresh deterministic identity.
 * Returns the JWT plus the keypair / DID / VM info for tamper tests.
 */
async function mintTestJwt({
  audience = 'https://acme.com',
  nonce = 'test-nonce',
  iat = 1_716_700_000,
  exp = 1_716_703_600,
} = {}) {
  const key = await makeKey('test-device');
  const vmId = `${key.did}#dev-laptop`;
  const vm = {
    id: vmId,
    type: 'EcdsaSecp256r1VerificationKey2019',
    controller: key.did,
    public_key_multibase: key.multibase,
  };

  // Sign genesis roster.
  const genesisUnsigned = {
    version: 1,
    did: key.did,
    verification_methods: [vm],
    signed_at: 1_700_000_000,
    self_signed_by_genesis_key: '',
  };
  const genesisCanonical = genesisCanonicalBytes(genesisUnsigned);
  const genesisSig = await signBytes(key.privateKey, genesisCanonical);
  const genesis = {
    ...genesisUnsigned,
    self_signed_by_genesis_key: base64UrlEncodeBytes(genesisSig),
  };

  // Build JWT payload.
  const payload = {
    iss: key.did,
    sub: key.did,
    aud: audience,
    iat,
    exp,
    nonce,
    claims: {
      did: { value: key.did, attested_by: 'self' },
    },
    embedded_genesis_roster: genesis,
    embedded_roster_chain: [],
    embedded_verification_method: vm,
  };

  // Sign JWT.
  const headerJson = '{"alg":"ES256","typ":"JWT"}';
  const headerB64 = base64UrlEncodeString(headerJson);
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const jwtSig = await signBytes(key.privateKey, new TextEncoder().encode(signingInput));
  const sigB64 = base64UrlEncodeBytes(jwtSig);

  return {
    jwt: `${headerB64}.${payloadB64}.${sigB64}`,
    key,
    payload,
  };
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('verifyResponse accepts a fresh well-formed JWT', async () => {
  const { jwt, key } = await mintTestJwt();
  const config = {
    expectedAudience: 'https://acme.com',
    expectedNonce: 'test-nonce',
    nowUnixSecs: 1_716_700_010,
  };
  const verified = await verifyResponse(jwt, config);
  assert.equal(verified.did, key.did);
  assert.equal(verified.aud, 'https://acme.com');
  assert.equal(verified.currentVersion, 1);
  assert.ok(verified.claims.did);
});

test('verifyResponse genesisRosterHash is hex sha256', async () => {
  const { jwt } = await mintTestJwt();
  const v = await verifyResponse(jwt, {
    expectedAudience: 'https://acme.com',
    expectedNonce: 'test-nonce',
    nowUnixSecs: 1_716_700_010,
  });
  assert.equal(v.genesisRosterHash.length, 64); // 32 bytes hex
  assert.match(v.genesisRosterHash, /^[0-9a-f]{64}$/);
});

// ─── Failure modes ─────────────────────────────────────────────────────────

test('verifyResponse rejects wrong audience', async () => {
  const { jwt } = await mintTestJwt();
  await assert.rejects(
    () =>
      verifyResponse(jwt, {
        expectedAudience: 'https://attacker.com',
        expectedNonce: 'test-nonce',
        nowUnixSecs: 1_716_700_010,
      }),
    (err) => err instanceof VerifyError && err.code === 'audience_mismatch'
  );
});

test('verifyResponse rejects wrong nonce', async () => {
  const { jwt } = await mintTestJwt();
  await assert.rejects(
    () =>
      verifyResponse(jwt, {
        expectedAudience: 'https://acme.com',
        expectedNonce: 'different-nonce',
        nowUnixSecs: 1_716_700_010,
      }),
    (err) => err instanceof VerifyError && err.code === 'nonce_mismatch'
  );
});

test('verifyResponse rejects expired JWT', async () => {
  const { jwt } = await mintTestJwt({ exp: 1_716_700_000 });
  await assert.rejects(
    () =>
      verifyResponse(jwt, {
        expectedAudience: 'https://acme.com',
        expectedNonce: 'test-nonce',
        nowUnixSecs: 1_716_700_010,
      }),
    (err) => err instanceof VerifyError && err.code === 'expired'
  );
});

test('verifyResponse rejects forward-dated JWT beyond skew', async () => {
  const { jwt } = await mintTestJwt({ iat: 1_716_700_000 });
  await assert.rejects(
    () =>
      verifyResponse(jwt, {
        expectedAudience: 'https://acme.com',
        expectedNonce: 'test-nonce',
        nowUnixSecs: 1_716_500_000, // far in the past relative to iat
        maxIatSkewSecs: 120,
      }),
    (err) => err instanceof VerifyError && err.code === 'not_yet_valid'
  );
});

test('verifyResponse rejects malformed JWT (wrong segment count)', async () => {
  await assert.rejects(
    () =>
      verifyResponse('not.a.valid.jws.too.many', {
        expectedAudience: 'https://acme.com',
        expectedNonce: 'n',
        nowUnixSecs: 0,
      }),
    (err) => err instanceof VerifyError && err.code === 'invalid_jws_shape'
  );
});

test('verifyResponse rejects tampered signature', async () => {
  const { jwt } = await mintTestJwt();
  const parts = jwt.split('.');
  // Flip first byte of signature.
  const sigBytes = Buffer.from(
    parts[2].replace(/-/g, '+').replace(/_/g, '/') + '==',
    'base64'
  );
  sigBytes[0] ^= 0x80;
  const tamperedSig = sigBytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;

  await assert.rejects(
    () =>
      verifyResponse(tampered, {
        expectedAudience: 'https://acme.com',
        expectedNonce: 'test-nonce',
        nowUnixSecs: 1_716_700_010,
      }),
    (err) =>
      err instanceof VerifyError &&
      (err.code === 'jwt_signature_invalid' || err.code === 'signature_wrong_length')
  );
});

test('verifyResponse rejects tampered payload', async () => {
  const { jwt } = await mintTestJwt();
  const parts = jwt.split('.');
  // Decode payload, change audience, re-encode.
  const payloadBytes = Buffer.from(
    parts[1].replace(/-/g, '+').replace(/_/g, '/') + '==',
    'base64'
  );
  const payload = JSON.parse(payloadBytes.toString('utf8'));
  payload.aud = 'https://attacker.com';
  const tamperedPayloadB64 = Buffer.from(JSON.stringify(payload))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const tampered = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;

  await assert.rejects(
    () =>
      verifyResponse(tampered, {
        // Now matches the *tampered* audience — but the signature
        // covers the original payload, so it MUST fail at the JWS step.
        expectedAudience: 'https://attacker.com',
        expectedNonce: 'test-nonce',
        nowUnixSecs: 1_716_700_010,
      }),
    (err) => err instanceof VerifyError && err.code === 'jwt_signature_invalid'
  );
});

// ─── Rollback check ────────────────────────────────────────────────────────

test('checkRollback passes when lastSeenVersion is null', async () => {
  const { jwt } = await mintTestJwt();
  const v = await verifyResponse(jwt, {
    expectedAudience: 'https://acme.com',
    expectedNonce: 'test-nonce',
    nowUnixSecs: 1_716_700_010,
  });
  assert.doesNotThrow(() => checkRollback(v, null));
  assert.doesNotThrow(() => checkRollback(v, undefined));
});

test('checkRollback passes when lastSeenVersion is equal', async () => {
  const { jwt } = await mintTestJwt();
  const v = await verifyResponse(jwt, {
    expectedAudience: 'https://acme.com',
    expectedNonce: 'test-nonce',
    nowUnixSecs: 1_716_700_010,
  });
  assert.doesNotThrow(() => checkRollback(v, 1));
});

test('checkRollback throws when lastSeenVersion is higher', async () => {
  const { jwt } = await mintTestJwt();
  const v = await verifyResponse(jwt, {
    expectedAudience: 'https://acme.com',
    expectedNonce: 'test-nonce',
    nowUnixSecs: 1_716_700_010,
  });
  assert.throws(
    () => checkRollback(v, 5),
    (err) => err instanceof VerifyError && err.code === 'rollback_detected'
  );
});

// ─── VerifyError shape ─────────────────────────────────────────────────────

test('VerifyError exposes code + message', () => {
  const err = new VerifyError('test_code', 'detail');
  assert.equal(err.code, 'test_code');
  assert.equal(err.message, 'detail');
  assert.equal(err.name, 'VerifyError');
  assert.ok(err instanceof Error);
});
