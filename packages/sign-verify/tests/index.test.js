/**
 * @matanetwork/sign-verify — verifier tests.
 *
 * Run with: `node --test tests/index.test.js`.
 *
 * Two strategies:
 *  1. Mint statement tokens in-test with webcrypto, then verify — proves the
 *     JS verifier accepts well-formed input + rejects every tamper.
 *  2. Verify a REAL token produced by the Rust `mata-sign` crate (captured
 *     from `cargo run -p mata-sign --example print_token`) — proves the JS
 *     and Rust implementations agree byte-for-byte on the wire format. This
 *     is the anti-drift gate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';

import { verifyStatement, matchesContent, VerifyError } from '../src/index.js';

const subtle = webcrypto.subtle;

// ─── Statement minter (JS-side, mirrors Rust mata-sign) ────────────────────

const GENESIS_DOMAIN = new TextEncoder().encode('mid-genesis-roster-v1');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let s = '';
  while (value > 0n) {
    s = BASE58_ALPHABET[Number(value % 58n)] + s;
    value /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = '1' + s;
  return s;
}

function base64UrlEncodeBytes(bytes) {
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
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
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

async function makeKey() {
  const keypair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPubkey = new Uint8Array(await subtle.exportKey('raw', keypair.publicKey));
  const x = rawPubkey.slice(1, 33);
  const y = rawPubkey.slice(33, 65);
  const compressed = new Uint8Array(33);
  compressed[0] = y[31] & 1 ? 0x03 : 0x02;
  compressed.set(x, 1);
  const did = `did:mata:${base58Encode(compressed)}`;
  const multibase = `z${base58Encode(compressed)}`;
  return { ...keypair, did, multibase };
}

async function signBytes(privateKey, bytes) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes);
  return new Uint8Array(sig);
}

function contentHashB64(content) {
  const digest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest();
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

/** Mint a full statement token against a fresh identity. */
async function mintStatement({
  content = 'the quick brown fox',
  contentType = 'text/plain',
  context = null,
  nonce = null,
  iat = 1_716_700_000,
  exp = null,
  preview = null,
} = {}) {
  const key = await makeKey();
  const vmId = `${key.did}#laptop`;
  const vm = {
    id: vmId,
    type: 'EcdsaSecp256r1VerificationKey2019',
    controller: key.did,
    public_key_multibase: key.multibase,
  };

  const genesisUnsigned = {
    version: 1,
    did: key.did,
    verification_methods: [vm],
    signed_at: 1_700_000_000,
    self_signed_by_genesis_key: '',
  };
  const genesisSig = await signBytes(key.privateKey, genesisCanonicalBytes(genesisUnsigned));
  const genesis = { ...genesisUnsigned, self_signed_by_genesis_key: base64UrlEncodeBytes(genesisSig) };

  const payload = {
    iss: key.did,
    iat,
    exp,
    nonce,
    context,
    content_type: contentType,
    content_hash: contentHashB64(content),
    content_preview: preview,
    embedded_genesis_roster: genesis,
    embedded_roster_chain: [],
    embedded_verification_method: vm,
  };

  const headerB64 = base64UrlEncodeString('{"alg":"ES256","typ":"JWT"}');
  const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const jwtSig = await signBytes(key.privateKey, new TextEncoder().encode(signingInput));
  const sigB64 = base64UrlEncodeBytes(jwtSig);

  return { token: `${headerB64}.${payloadB64}.${sigB64}`, key, content, payload };
}

// ─── Happy path ────────────────────────────────────────────────────────────

test('verifyStatement accepts a fresh statement + matchesContent binds the bytes', async () => {
  const { token, key, content } = await mintStatement({ content: 'hello world', contentType: 'text/markdown' });
  const v = await verifyStatement(token, { nowUnixSecs: 1_716_700_010 });
  assert.equal(v.did, key.did);
  assert.equal(v.contentType, 'text/markdown');
  assert.equal(v.currentVersion, 1);
  assert.equal(v.contentHash.length, 64);
  assert.match(v.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(matchesContent(v, content), true);
  assert.equal(matchesContent(v, 'tampered'), false);
});

// ─── Cross-implementation conformance: a REAL Rust mata-sign token ─────────

test('verifyStatement accepts a token produced by the Rust mata-sign crate', async () => {
  // Captured from: cargo run -p mata-sign --example print_token
  const RUST_DID = 'did:mata:t2FdEXE7eihG1ushsgYc4poTtg2Tt7WNi9NNFwhHFZmr';
  const RUST_CONTENT = 'I am a real human. — signed via MATA';
  const RUST_TOKEN =
    'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkaWQ6bWF0YTp0MkZkRVhFN2VpaEcxdXNoc2dZYzRwb1R0ZzJUdDdXTmk5Tk5Gd2hIRlptciIsImlhdCI6MTcxNjcwMDAwMCwiZXhwIjpudWxsLCJub25jZSI6bnVsbCwiY29udGV4dCI6ImlhbWh1bWFuIiwiY29udGVudF90eXBlIjoidGV4dC9wbGFpbiIsImNvbnRlbnRfaGFzaCI6ImlUZGJOVmxlYXdyNUhjek9mdXAtMlI4Q3BwUGwwOFNISFRDVVgtN2Y0STQiLCJjb250ZW50X3ByZXZpZXciOiJJIGFtIGEgcmVhbCBodW1hbi4g4oCUIHNpZ25lZCB2aWEgTUFUQSIsImVtYmVkZGVkX2dlbmVzaXNfcm9zdGVyIjp7InZlcnNpb24iOjEsImRpZCI6ImRpZDptYXRhOnQyRmRFWEU3ZWloRzF1c2hzZ1ljNHBvVHRnMlR0N1dOaTlOTkZ3aEhGWm1yIiwidmVyaWZpY2F0aW9uX21ldGhvZHMiOlt7ImlkIjoiZGlkOm1hdGE6dDJGZEVYRTdlaWhHMXVzaHNnWWM0cG9UdGcyVHQ3V05pOU5ORndoSEZabXIjbGFwdG9wIiwidHlwZSI6IkVjZHNhU2VjcDI1NnIxVmVyaWZpY2F0aW9uS2V5MjAxOSIsImNvbnRyb2xsZXIiOiJkaWQ6bWF0YTp0MkZkRVhFN2VpaEcxdXNoc2dZYzRwb1R0ZzJUdDdXTmk5Tk5Gd2hIRlptciIsInB1YmxpY19rZXlfbXVsdGliYXNlIjoienQyRmRFWEU3ZWloRzF1c2hzZ1ljNHBvVHRnMlR0N1dOaTlOTkZ3aEhGWm1yIn1dLCJzaWduZWRfYXQiOjE3MDAwMDAwMDAsInNlbGZfc2lnbmVkX2J5X2dlbmVzaXNfa2V5IjoiLXVNTURFYUtYc05qLWx4dFpqc1hhQVZMSEkwd2hXVXV3SHAzSUZHSl8yWjZLUnN3ZGtpSzZwVW0tYmY5WkdyRzFSUTBpeWctNG53Zm9DejlDVmI5cFEifSwiZW1iZWRkZWRfcm9zdGVyX2NoYWluIjpbXSwiZW1iZWRkZWRfdmVyaWZpY2F0aW9uX21ldGhvZCI6eyJpZCI6ImRpZDptYXRhOnQyRmRFWEU3ZWloRzF1c2hzZ1ljNHBvVHRnMlR0N1dOaTlOTkZ3aEhGWm1yI2xhcHRvcCIsInR5cGUiOiJFY2RzYVNlY3AyNTZyMVZlcmlmaWNhdGlvbktleTIwMTkiLCJjb250cm9sbGVyIjoiZGlkOm1hdGE6dDJGZEVYRTdlaWhHMXVzaHNnWWM0cG9UdGcyVHQ3V05pOU5ORndoSEZabXIiLCJwdWJsaWNfa2V5X211bHRpYmFzZSI6Inp0MkZkRVhFN2VpaEcxdXNoc2dZYzRwb1R0ZzJUdDdXTmk5Tk5Gd2hIRlptciJ9fQ.j9rNfTYqRNBrPqegnpr6sI-A_7nOnoYVXuoPr7GOjoUee7BcG3p1xdjJuun8aqlTjubwi_s2uhqxnp5p8HCHPg';

  const v = await verifyStatement(RUST_TOKEN, { nowUnixSecs: 1_716_700_010, expectedContext: 'iamhuman' });
  assert.equal(v.did, RUST_DID);
  assert.equal(v.context, 'iamhuman');
  assert.equal(v.contentType, 'text/plain');
  assert.equal(v.exp, null);
  assert.equal(v.preview, RUST_CONTENT);
  assert.equal(matchesContent(v, RUST_CONTENT), true, 'JS confirms the Rust-signed content hash');
  assert.equal(matchesContent(v, 'I am a bot'), false);
});

// ─── Failure modes ─────────────────────────────────────────────────────────

test('verifyStatement rejects a tampered payload', async () => {
  const { token } = await mintStatement();
  const parts = token.split('.');
  const payloadBytes = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
  const payload = JSON.parse(payloadBytes.toString('utf8'));
  payload.content_type = 'application/x-evil';
  const tamperedB64 = Buffer.from(JSON.stringify(payload)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const tampered = `${parts[0]}.${tamperedB64}.${parts[2]}`;
  await assert.rejects(
    () => verifyStatement(tampered, { nowUnixSecs: 1_716_700_010 }),
    (err) => err instanceof VerifyError && err.code === 'jwt_signature_invalid'
  );
});

test('verifyStatement rejects a tampered signature', async () => {
  const { token } = await mintStatement();
  const parts = token.split('.');
  const sigBytes = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
  sigBytes[0] ^= 0x80;
  const tamperedSig = sigBytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await assert.rejects(
    () => verifyStatement(`${parts[0]}.${parts[1]}.${tamperedSig}`, { nowUnixSecs: 1_716_700_010 }),
    (err) => err instanceof VerifyError &&
      (err.code === 'jwt_signature_invalid' || err.code === 'signature_wrong_length')
  );
});

// A forger takes a rostered verification-method id, attaches their own key,
// and signs with it. The JWS step verifies against the embedded key, so the
// head-roster step must bind the key, not just the id (mirrors the Rust
// mid-verify test `a_rostered_id_with_a_strangers_key_is_rejected`).
test('verifyStatement rejects a rostered id carrying a stranger\'s key', async () => {
  const { payload } = await mintStatement();
  const stranger = await makeKey();
  const forged = {
    ...payload,
    embedded_verification_method: {
      ...payload.embedded_verification_method,
      public_key_multibase: stranger.multibase,
    },
  };
  const headerB64 = base64UrlEncodeString('{"alg":"ES256","typ":"JWT"}');
  const signingInput = `${headerB64}.${base64UrlEncodeString(JSON.stringify(forged))}`;
  const sig = await signBytes(stranger.privateKey, new TextEncoder().encode(signingInput));
  await assert.rejects(
    () => verifyStatement(`${signingInput}.${base64UrlEncodeBytes(sig)}`, { nowUnixSecs: 1_716_700_010 }),
    (err) => err instanceof VerifyError && err.code === 'current_vm_not_in_head_roster'
  );
});

test('verifyStatement rejects an expired statement', async () => {
  const { token } = await mintStatement({ exp: 1_716_700_100 });
  await assert.rejects(
    () => verifyStatement(token, { nowUnixSecs: 1_716_700_500 }),
    (err) => err instanceof VerifyError && err.code === 'expired'
  );
  // no-exp statements never expire
  const { token: forever } = await mintStatement({ exp: null });
  const v = await verifyStatement(forever, { nowUnixSecs: 9_999_999_999 });
  assert.equal(v.exp, null);
});

test('verifyStatement rejects a forward-dated statement beyond skew', async () => {
  const { token } = await mintStatement({ iat: 1_716_700_000 });
  await assert.rejects(
    () => verifyStatement(token, { nowUnixSecs: 1_716_500_000, maxIatSkewSecs: 120 }),
    (err) => err instanceof VerifyError && err.code === 'not_yet_valid'
  );
});

test('verifyStatement enforces context binding', async () => {
  const { token } = await mintStatement({ context: 'iamhuman', preview: 'my post' });
  // matching context ok
  const v = await verifyStatement(token, { nowUnixSecs: 1_716_700_010, expectedContext: 'iamhuman' });
  assert.equal(v.context, 'iamhuman');
  assert.equal(v.preview, 'my post');
  // wrong expected context rejected
  await assert.rejects(
    () => verifyStatement(token, { nowUnixSecs: 1_716_700_010, expectedContext: 'mata-doc' }),
    (err) => err instanceof VerifyError && err.code === 'context_mismatch'
  );
});

test('verifyStatement enforces nonce binding', async () => {
  const { token } = await mintStatement({ nonce: 'n-123' });
  await assert.rejects(
    () => verifyStatement(token, { nowUnixSecs: 1_716_700_010, expectedNonce: 'n-999' }),
    (err) => err instanceof VerifyError && err.code === 'nonce_mismatch'
  );
  const v = await verifyStatement(token, { nowUnixSecs: 1_716_700_010, expectedNonce: 'n-123' });
  assert.equal(v.did.startsWith('did:mata:'), true);
});

test('verifyStatement rejects malformed token (wrong segment count)', async () => {
  await assert.rejects(
    () => verifyStatement('too.many.segments.here', { nowUnixSecs: 0 }),
    (err) => err instanceof VerifyError && err.code === 'invalid_jws_shape'
  );
});

test('verifyStatement requires nowUnixSecs', async () => {
  const { token } = await mintStatement();
  await assert.rejects(
    () => verifyStatement(token, {}),
    (err) => err instanceof VerifyError && err.code === 'config'
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
