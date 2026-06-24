/**
 * Mock wallet for the Sovereign ID hello-world demo.
 *
 * ⚠️  DEV-ONLY. This module exists so the demo can sign JWTs without
 * requiring the user to install the MATA browser extension or native
 * app. In production, that signing happens inside the user's wallet on
 * a hardware-backed key — never on a server, never with a deterministic
 * test key.
 *
 * The mock wallet:
 *
 *  1. Generates an in-memory ECDSA P-256 keypair (lost on restart).
 *  2. Derives the DID + multibase pubkey using the same encoding the
 *     real wallet uses.
 *  3. Self-signs the genesis roster.
 *  4. Mints a JWT against the provided RpRequest.
 *
 * The minted JWT is bit-compatible with `@matanetwork/sovereign-id-verify` and
 * the Rust `mid-verify` crate. Proves the protocol works end-to-end
 * without any platform-specific signing infrastructure.
 */

import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;

// ─── Wire constants (mirror ADR 0005 + mid-issuer::canonical) ──────────────

const GENESIS_DOMAIN = new TextEncoder().encode('mid-genesis-roster-v1');
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// ─── Encoding helpers ──────────────────────────────────────────────────────

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
  return Buffer.from(bytes)
    .toString('base64')
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

// ─── Mock wallet ───────────────────────────────────────────────────────────

/**
 * In-memory mock wallet. One per process; the keypair is generated on
 * first sign and reused for the lifetime of the demo.
 */
class MockWallet {
  constructor() {
    this._initPromise = null;
    this.did = null;
    this.multibase = null;
    this.vm = null;
    this.genesisRoster = null;
    this.signingKey = null;
  }

  async ensureInitialized() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._initialize();
    return this._initPromise;
  }

  async _initialize() {
    // Generate ECDSA P-256 keypair.
    const keypair = await subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    this.signingKey = keypair.privateKey;

    // Compress the public key.
    const rawPubkey = new Uint8Array(await subtle.exportKey('raw', keypair.publicKey));
    const x = rawPubkey.slice(1, 33);
    const y = rawPubkey.slice(33, 65);
    const yIsOdd = y[31] & 1;
    const compressed = new Uint8Array(33);
    compressed[0] = yIsOdd ? 0x03 : 0x02;
    compressed.set(x, 1);

    this.did = `did:mata:${base58Encode(compressed)}`;
    this.multibase = `z${base58Encode(compressed)}`;
    this.vm = {
      id: `${this.did}#dev-laptop`,
      type: 'EcdsaSecp256r1VerificationKey2019',
      controller: this.did,
      public_key_multibase: this.multibase,
    };

    // Self-sign the genesis roster.
    const genesisUnsigned = {
      version: 1,
      did: this.did,
      verification_methods: [this.vm],
      signed_at: Math.floor(Date.now() / 1000) - 86_400 * 30, // "30 days ago"
      self_signed_by_genesis_key: '',
    };
    const canonical = genesisCanonicalBytes(genesisUnsigned);
    const sig = await this.signBytes(canonical);
    this.genesisRoster = {
      ...genesisUnsigned,
      self_signed_by_genesis_key: base64UrlEncodeBytes(sig),
    };
  }

  async signBytes(bytes) {
    return new Uint8Array(
      await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.signingKey, bytes)
    );
  }

  /**
   * Mint a JWT against the supplied request. Mirrors the `signIn` API
   * shape of the real wallet, but produces the JWT here instead of via
   * extension postMessage / native deep link.
   *
   * @param {object} request
   * @param {string} request.rpOrigin
   * @param {string} request.nonce
   * @param {object} request.claims
   * @param {object} [profile] - user's profile values (email, name)
   * @returns {Promise<string>} JWS compact-form JWT
   */
  async signRequest(request, profile = {}) {
    await this.ensureInitialized();

    const now = Math.floor(Date.now() / 1000);
    const iat = now;
    const exp = now + 3600;

    const allClaimKeys = [
      ...request.claims.required,
      ...(request.claims.optional || []),
    ];

    const claims = {};
    for (const key of allClaimKeys) {
      const value = resolveClaimValue(key, this.did, profile);
      if (value === null) continue;
      claims[key] = value;
    }

    const payload = {
      iss: this.did,
      sub: this.did,
      aud: request.rpOrigin,
      iat,
      exp,
      nonce: request.nonce,
      claims,
      embedded_genesis_roster: this.genesisRoster,
      embedded_roster_chain: [],
      embedded_verification_method: this.vm,
    };

    // Build JWS compact form.
    const headerB64 = base64UrlEncodeString('{"alg":"ES256","typ":"JWT"}');
    const payloadB64 = base64UrlEncodeString(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;
    const jwtSig = await this.signBytes(new TextEncoder().encode(signingInput));
    return `${signingInput}.${base64UrlEncodeBytes(jwtSig)}`;
  }
}

/**
 * Map a claim key + user profile to a populated ClaimValue. Returns
 * null when the source value isn't available (e.g. user has no email).
 * Mirrors the Rust `mid_claim_builder::build_one_claim`.
 *
 * @internal
 */
function resolveClaimValue(key, did, profile) {
  switch (key) {
    case 'did':
      return { value: did, attested_by: 'self' };
    case 'email':
      if (!profile.email) return null;
      return {
        value: profile.email,
        attested_by: 'self',
        verified_at_signup: true,
      };
    case 'name':
      if (!profile.name) return null;
      return { value: profile.name, attested_by: 'self' };
    case 'created_at':
      return {
        value: profile.created_at || Math.floor(Date.now() / 1000) - 86_400 * 30,
        attested_by: 'self',
      };
    case 'paired_devices_count':
      return { value: profile.paired_devices_count || 1, attested_by: 'self' };
    case 'level_rating.trust':
      return {
        value: profile.trust_score || 15,
        attested_by: 'self',
        computed_at: Math.floor(Date.now() / 1000),
        formula_version: 'v0',
      };
    case 'level_rating.security':
      return {
        value: profile.security_score || 70,
        attested_by: 'self',
        computed_at: Math.floor(Date.now() / 1000),
        formula_version: 'v0',
      };
    case 'level_rating.incentive':
      return {
        value: profile.incentive_score || 10,
        attested_by: 'self',
        computed_at: Math.floor(Date.now() / 1000),
        formula_version: 'v0',
      };
    default:
      // Custom claims — v0 not supported.
      return null;
  }
}

export { MockWallet };
