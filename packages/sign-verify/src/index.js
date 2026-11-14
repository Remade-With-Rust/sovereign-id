/**
 * @matanetwork/sign-verify — Node/Deno/Bun verifier for MATA **signed
 * statements**.
 *
 * A signed statement proves a `did:mata` authored a piece of content — a
 * hiring document, a contract, or an IAMHUMAN post (a PGP-equivalent for the
 * open web). The token is **self-contained**: the signer's device roster +
 * proof-of-control travel inside it, so anyone verifies offline with **zero
 * MATA lookups**.
 *
 * This mirrors the Rust `mata-sign` crate (which itself reuses the `mid-verify`
 * checks) entirely in JavaScript using the Web Crypto API for ECDSA P-256 +
 * SHA-256. The four cryptographic checks are byte-for-byte identical to
 * `@matanetwork/sovereign-id-verify` — only the payload metadata differs
 * (content instead of sign-in claims).
 *
 * ## Flow
 *
 *  1. Parse the JWS compact-form token into header / payload / signature.
 *  2. Verify the genesis roster's self-signature against the key recoverable
 *     from the DID.
 *  3. Walk the roster chain — every entry signed by a VM in the prior roster;
 *     versions strictly monotonic.
 *  4. Confirm the signing verification method is in the head roster.
 *  5. Verify the JWS outer signature against that VM's pubkey.
 *  6. Check freshness (`exp` / `iat` skew) and optional `context` / `nonce`
 *     binding.
 *
 * The signature proves **who**; the embedded `content_hash` proves **what**.
 * Call {@link matchesContent} with the bytes you hold to bind the two — the
 * content itself is *not* in the token (detached signing).
 */

import { webcrypto, createHash } from 'node:crypto';

const subtle = webcrypto.subtle;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Verify a MATA signed-statement token.
 *
 * @param {string} token - JWS compact-form statement token
 * @param {object} opts
 * @param {number} opts.nowUnixSecs - Current wall-clock time (Unix seconds)
 * @param {number} [opts.maxIatSkewSecs] - Allowed forward skew. Default 120.
 * @param {string} [opts.expectedContext] - If set, the statement's `context`
 *   MUST equal this (e.g. `"iamhuman"`). Prevents cross-use replay.
 * @param {string} [opts.expectedNonce] - If set, the statement's `nonce` MUST
 *   equal this.
 * @returns {Promise<VerifiedStatement>}
 * @throws {VerifyError}
 */
export async function verifyStatement(token, opts) {
  if (!opts || typeof opts.nowUnixSecs !== 'number') {
    throw new VerifyError('config', 'opts.nowUnixSecs (number) is required');
  }

  // ─── 1. Split JWS + validate header ──────────────────────────────────────
  const parts = splitJws(token);
  validateJwsHeader(parts.header);

  let stmt;
  try {
    stmt = JSON.parse(new TextDecoder().decode(parts.payloadBytes));
  } catch (e) {
    throw new VerifyError('payload_json', `payload not valid JSON: ${e.message}`);
  }

  // ─── 2. Four cryptographic checks (identical to mID) ─────────────────────
  await checkGenesisSelfSignature(stmt);
  await checkRosterChain(stmt);
  checkCurrentVmInHead(stmt);
  await checkJwsSignature(stmt, parts.signingInput, parts.signatureBytes);

  // ─── 3. Freshness + binding (statement-specific) ─────────────────────────
  const now = opts.nowUnixSecs;
  const skew = opts.maxIatSkewSecs ?? 120;
  // `exp` is optional for statements (documents may never expire). serde
  // serializes a Rust `None` as JSON `null`, so treat null/undefined as "no
  // expiry".
  if (stmt.exp != null && now >= stmt.exp) {
    throw new VerifyError('expired', `exp=${stmt.exp}, now=${now}`);
  }
  if (stmt.iat > now + skew) {
    throw new VerifyError('not_yet_valid', `iat=${stmt.iat}, now=${now}, max skew ${skew}s`);
  }
  if (opts.expectedContext != null && (stmt.context ?? null) !== opts.expectedContext) {
    throw new VerifyError(
      'context_mismatch',
      `expected '${opts.expectedContext}', got '${stmt.context ?? null}'`
    );
  }
  if (opts.expectedNonce != null && (stmt.nonce ?? null) !== opts.expectedNonce) {
    throw new VerifyError('nonce_mismatch', 'possible replay or stale request');
  }

  // ─── 4. Decode the committed content hash + head version ─────────────────
  let contentHashBytes;
  try {
    contentHashBytes = base64UrlDecodeBytes(stmt.content_hash);
  } catch (e) {
    throw new VerifyError('malformed_content_hash', e.message);
  }
  if (contentHashBytes.length !== 32) {
    throw new VerifyError(
      'malformed_content_hash',
      `content_hash is ${contentHashBytes.length} bytes, expected 32`
    );
  }
  const contentHash = toHex(contentHashBytes);

  const chain = stmt.embedded_roster_chain || [];
  const currentVersion =
    chain.length > 0 ? chain[chain.length - 1].version : stmt.embedded_genesis_roster.version;

  return {
    did: stmt.iss,
    contentHash,
    contentType: stmt.content_type,
    currentVersion,
    iat: stmt.iat,
    exp: stmt.exp ?? null,
    context: stmt.context ?? null,
    preview: stmt.content_preview ?? null,
  };
}

/**
 * Confirm that `content` is exactly what was signed: recompute SHA-256 and
 * compare to the hash committed in the token. The signature proves who; this
 * proves what. Call it after {@link verifyStatement}.
 *
 * @param {VerifiedStatement} verified - the result of `verifyStatement`
 * @param {string | Uint8Array | ArrayBuffer | Buffer} content - the bytes you hold
 * @returns {boolean}
 */
export function matchesContent(verified, content) {
  const bytes =
    typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content);
  const hex = createHash('sha256').update(bytes).digest('hex');
  return hex === verified.contentHash;
}

// ─── VerifyError ───────────────────────────────────────────────────────────

/**
 * Error thrown by the verifier on any failure. `.code` is a stable snake_case
 * string matching the Rust check that failed.
 */
export class VerifyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}

// ─── Step 1: split + header ────────────────────────────────────────────────

/** @internal */
function splitJws(jwt) {
  const segments = jwt.split('.');
  if (segments.length !== 3) {
    throw new VerifyError('invalid_jws_shape', `expected 3 segments, got ${segments.length}`);
  }
  const [headerB64, payloadB64, signatureB64] = segments;

  let headerBytes, payloadBytes, signatureBytes;
  try {
    headerBytes = base64UrlDecodeBytes(headerB64);
    payloadBytes = base64UrlDecodeBytes(payloadB64);
    signatureBytes = base64UrlDecodeBytes(signatureB64);
  } catch (e) {
    throw new VerifyError('base64_decode', e.message);
  }

  if (signatureBytes.length !== 64) {
    throw new VerifyError('signature_wrong_length', `expected 64 bytes, got ${signatureBytes.length}`);
  }

  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch (e) {
    throw new VerifyError('invalid_jws_header', `header not valid JSON: ${e.message}`);
  }

  return { header, payloadBytes, signatureBytes, signingInput: `${headerB64}.${payloadB64}` };
}

/** @internal */
function validateJwsHeader(header) {
  if (header.alg !== 'ES256' || header.typ !== 'JWT') {
    throw new VerifyError(
      'invalid_jws_header',
      `alg must be ES256, typ must be JWT (got alg=${header.alg}, typ=${header.typ})`
    );
  }
}

// ─── Cryptographic checks (mirror Rust mid-verify::checks) ─────────────────

/** @internal */
async function checkGenesisSelfSignature(payload) {
  const genesis = payload.embedded_genesis_roster;
  if (!genesis) {
    throw new VerifyError('payload_json', 'missing embedded_genesis_roster');
  }
  const genesisPubkey = pubkeyFromDid(payload.iss);
  const message = genesisCanonicalBytes(genesis);
  const sig = base64UrlDecodeBytes(genesis.self_signed_by_genesis_key);

  const ok = await ecdsaP256Verify(genesisPubkey, message, sig);
  if (!ok) {
    throw new VerifyError(
      'genesis_signature_invalid',
      'genesis self-signature did not verify against DID-recovered key'
    );
  }
}

/** @internal */
async function checkRosterChain(payload) {
  const chain = payload.embedded_roster_chain || [];
  let priorVms = payload.embedded_genesis_roster.verification_methods;
  let priorVersion = payload.embedded_genesis_roster.version;

  for (const entry of chain) {
    if (entry.version <= priorVersion) {
      throw new VerifyError(
        'chain_version_not_monotonic',
        `entry version ${entry.version} <= prior ${priorVersion}`
      );
    }

    const kidSuffix = `#${entry.signer_kid}`;
    const signerVm = priorVms.find((vm) => vm.id.endsWith(kidSuffix));
    if (!signerVm) {
      throw new VerifyError(
        'chain_signer_not_in_prior_roster',
        `version ${entry.version} signer '${entry.signer_kid}' not in prior roster`
      );
    }

    const signerPubkey = pubkeyFromMultibase(signerVm.public_key_multibase, signerVm.id);
    const message = chainEntryCanonicalBytes(entry);
    const sig = base64UrlDecodeBytes(entry.signed_by_signer_in_prior_roster);

    const ok = await ecdsaP256Verify(signerPubkey, message, sig);
    if (!ok) {
      throw new VerifyError(
        'chain_signature_invalid',
        `entry version ${entry.version} signature did not verify`
      );
    }

    priorVms = entry.verification_methods;
    priorVersion = entry.version;
  }
}

/** @internal */
function checkCurrentVmInHead(payload) {
  const chain = payload.embedded_roster_chain || [];
  const headVms =
    chain.length > 0
      ? chain[chain.length - 1].verification_methods
      : payload.embedded_genesis_roster.verification_methods;
  // The JWS signature is checked against the key embedded in the token, so the
  // whole method must match a head-roster entry, key included. An id-only match
  // lets anyone pair a rostered id with their own key and pass.
  const current = payload.embedded_verification_method;
  const currentId = current.id;
  const rostered = headVms.some(
    (vm) =>
      vm.id === current.id &&
      vm.public_key_multibase === current.public_key_multibase &&
      vm.type === current.type &&
      vm.controller === current.controller
  );
  if (!rostered) {
    throw new VerifyError(
      'current_vm_not_in_head_roster',
      `'${currentId}' is not in the head roster — device may have been revoked`
    );
  }
}

/** @internal */
async function checkJwsSignature(payload, signingInput, signatureBytes) {
  const vm = payload.embedded_verification_method;
  const pubkey = pubkeyFromMultibase(vm.public_key_multibase, vm.id);
  const message = new TextEncoder().encode(signingInput);
  const ok = await ecdsaP256Verify(pubkey, message, signatureBytes);
  if (!ok) {
    throw new VerifyError(
      'jwt_signature_invalid',
      'JWS outer signature did not verify against embedded verification method'
    );
  }
}

// ─── ECDSA P-256 verification ──────────────────────────────────────────────

/**
 * Verify an ECDSA P-256 signature over `message` (SHA-256-hashed internally)
 * using a 33-byte SEC1-compressed pubkey + a 64-byte r||s signature.
 * @internal
 */
async function ecdsaP256Verify(compressedPubkey, message, signatureRS) {
  const uncompressed = decompressP256Pubkey(compressedPubkey);
  const key = await subtle.importKey(
    'raw',
    uncompressed,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureRS, message);
}

/**
 * Decompress a 33-byte SEC1-compressed P-256 pubkey to 65 bytes using
 * y² = x³ + ax + b (mod p). p ≡ 3 (mod 4) lets us take the square root by
 * exponentiation.
 * @internal
 */
function decompressP256Pubkey(compressed) {
  if (compressed.length !== 33) {
    throw new VerifyError(
      'malformed_vm_pubkey',
      `expected 33 bytes compressed pubkey, got ${compressed.length}`
    );
  }
  const prefix = compressed[0];
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new VerifyError('malformed_vm_pubkey', `unknown compression prefix 0x${prefix.toString(16)}`);
  }

  const p = 0xffffffff_00000001_00000000_00000000_00000000_ffffffff_ffffffff_ffffffffn;
  const a = 0xffffffff_00000001_00000000_00000000_00000000_ffffffff_ffffffff_fffffffcn;
  const b = 0x5ac635d8_aa3a93e7_b3ebbd55_769886bc_651d06b0_cc53b0f6_3bce3c3e_27d2604bn;

  let x = 0n;
  for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(compressed[1 + i]);

  const ySquared = mod(x * x * x + a * x + b, p);
  let y = powMod(ySquared, (p + 1n) / 4n, p);

  if (mod(y * y, p) !== ySquared) {
    throw new VerifyError('malformed_vm_pubkey', 'pubkey not on P-256 curve');
  }

  const wantedParity = prefix === 0x02 ? 0n : 1n;
  if (y % 2n !== wantedParity) y = p - y;

  const out = new Uint8Array(65);
  out[0] = 0x04;
  for (let i = 31; i >= 0; i--) {
    out[1 + i] = Number(x & 0xffn);
    x >>= 8n;
  }
  for (let i = 31; i >= 0; i--) {
    out[33 + i] = Number(y & 0xffn);
    y >>= 8n;
  }
  return out;
}

/** @internal */
function mod(a, m) {
  return ((a % m) + m) % m;
}

/** @internal */
function powMod(base, exp, m) {
  let result = 1n;
  base = base % m;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % m;
    exp >>= 1n;
    base = (base * base) % m;
  }
  return result;
}

// ─── Canonical bytes (mirror Rust mid-issuer::canonical) ───────────────────

const GENESIS_DOMAIN = new TextEncoder().encode('mid-genesis-roster-v1');
const CHAIN_ENTRY_DOMAIN = new TextEncoder().encode('mid-roster-chain-v1');

/** @internal */
function genesisCanonicalBytes(genesis) {
  const buf = new BytesBuilder();
  buf.appendBytes(GENESIS_DOMAIN);
  buf.appendU64BE(genesis.version);
  buf.appendString(genesis.did);
  buf.appendVms(genesis.verification_methods);
  buf.appendU64BE(genesis.signed_at);
  return buf.finish();
}

/** @internal */
function chainEntryCanonicalBytes(entry) {
  const buf = new BytesBuilder();
  buf.appendBytes(CHAIN_ENTRY_DOMAIN);
  buf.appendU64BE(entry.version);
  buf.appendString(entry.did);
  buf.appendVms(entry.verification_methods);
  buf.appendU64BE(entry.signed_at);
  buf.appendString(entry.signer_kid);
  return buf.finish();
}

/**
 * Length-prefixed binary builder mirroring the Rust crate's layout. Length
 * prefixes are big-endian u32 / u64.
 * @internal
 */
class BytesBuilder {
  constructor() {
    this.parts = [];
  }

  appendBytes(bytes) {
    for (const b of bytes) this.parts.push(b);
  }

  appendU32BE(n) {
    this.parts.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  appendU64BE(n) {
    const hi = Math.floor(n / 0x1_0000_0000);
    const lo = n >>> 0;
    this.parts.push(
      (hi >>> 24) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff
    );
  }

  appendString(s) {
    const utf8 = new TextEncoder().encode(s);
    this.appendU32BE(utf8.length);
    this.appendBytes(utf8);
  }

  appendVms(vms) {
    this.appendU32BE(vms.length);
    for (const vm of vms) {
      this.appendString(vm.id);
      this.appendString(vm.type);
      this.appendString(vm.controller);
      this.appendString(vm.public_key_multibase);
    }
  }

  finish() {
    return new Uint8Array(this.parts);
  }
}

// ─── DID + multibase decoding ──────────────────────────────────────────────

/** @internal */
function pubkeyFromDid(did) {
  if (!did.startsWith('did:mata:')) {
    throw new VerifyError('malformed_did', `DID '${did}' does not start with 'did:mata:'`);
  }
  const bytes = base58Decode(did.slice('did:mata:'.length));
  if (bytes.length !== 33) {
    throw new VerifyError('malformed_did', `DID '${did}' decodes to ${bytes.length} bytes, expected 33`);
  }
  return bytes;
}

/** @internal */
function pubkeyFromMultibase(mb, vmId) {
  if (!mb.startsWith('z')) {
    throw new VerifyError('malformed_vm_pubkey', `VM '${vmId}' multibase does not start with 'z'`);
  }
  const bytes = base58Decode(mb.slice(1));
  if (bytes.length !== 33) {
    throw new VerifyError('malformed_vm_pubkey', `VM '${vmId}' multibase decodes to ${bytes.length} bytes, expected 33`);
  }
  return bytes;
}

// ─── base58btc decoding ────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_REVERSE = (() => {
  const m = new Map();
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m.set(BASE58_ALPHABET[i], i);
  return m;
})();

/** @internal */
function base58Decode(s) {
  let value = 0n;
  for (const ch of s) {
    const digit = BASE58_REVERSE.get(ch);
    if (digit === undefined) {
      throw new VerifyError('malformed_did', `invalid base58 char '${ch}'`);
    }
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  let leadingZeros = 0;
  for (let i = 0; i < s.length && s[i] === '1'; i++) leadingZeros++;
  const result = new Uint8Array(leadingZeros + out.length);
  result.set(out, leadingZeros);
  return result;
}

// ─── Encoding helpers ──────────────────────────────────────────────────────

/** @internal */
function base64UrlDecodeBytes(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** @internal */
function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
