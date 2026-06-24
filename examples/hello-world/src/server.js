/**
 * Hello-world demo for MATA Sovereign ID — Express RP backend.
 *
 * Endpoints:
 *
 *  - GET  /                   — serves the demo HTML page
 *  - GET  /api/nonce          — issues a single-use nonce (CSRF-style)
 *  - POST /api/verify         — verifies a JWT, returns the disclosed claims
 *  - POST /api/dev/mock-jwt   — (dev-only) mints a JWT via the mock wallet
 *
 * The /api/dev/mock-jwt path stands in for the real wallet so the demo
 * runs without requiring the MATA extension or native app to be
 * installed. In production, the page-side `@matanetwork/sovereign-id` SDK
 * would produce the JWT directly via `signIn()`.
 */

import express from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { verifyResponse, checkRollback, VerifyError } from '@matanetwork/sovereign-id-verify';
import { MockWallet } from './wallet-mock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3000;
// The audience the JWT must match. Set explicitly in production (e.g.
// on fly.io we set RP_ORIGIN to the public https URL); falls back to
// localhost for local dev so the existing `npm start` flow still works.
//
// The SDK on the page uses `window.location.origin`; the verifier on
// this server compares against `RP_ORIGIN`. They MUST be the same
// string for the JWT's `aud` claim to validate.
const RP_ORIGIN = process.env.RP_ORIGIN || `http://localhost:${PORT}`;

// ─── In-memory stores ──────────────────────────────────────────────────────
//
// Real production code wires these to a session store + Postgres. For
// the demo, plain Maps keep the surface small + readable.

/** nonce → { issued_at } */
const nonces = new Map();
/** did → { genesis_roster_hash, last_seen_roster_version, first_signed_in_at, last_signed_in_at, email, name } */
const users = new Map();

// Single mock wallet shared across the process. Keeps the demo
// behaving as one "user" across sign-ins so the rollback detection +
// genesis-hash anchoring patterns are observable.
const mockWallet = new MockWallet();

// ─── Express setup ─────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));
// Serve the @matanetwork/sovereign-id SDK source at /sdk so the demo's
// browser-side app.js can import it without a bundler. In production
// RPs would bundle the SDK via Webpack/Vite/esbuild; this route is
// just a no-build path for the demo.
//
// Resolved out of node_modules so the same path works locally (npm
// install symlinks) and inside the fly.io Docker image (real installed
// package — sibling workspace directories don't exist there).
app.use(
  '/sdk',
  express.static(
    join(__dirname, '..', 'node_modules', '@matanetwork', 'sovereign-id', 'src')
  )
);

// ─── /api/nonce ────────────────────────────────────────────────────────────

app.get('/api/nonce', (_req, res) => {
  const nonce = randomBytes(32).toString('hex');
  nonces.set(nonce, { issued_at: Date.now() });
  res.type('text/plain').send(nonce);
});

// ─── /api/verify ───────────────────────────────────────────────────────────

app.post('/api/verify', async (req, res) => {
  const { jwt } = req.body;
  if (typeof jwt !== 'string' || jwt.length === 0) {
    return res.status(400).json({ error: 'invalid_request', message: 'jwt missing' });
  }

  // Pull the most recently-issued nonce. Real production code keys
  // this by session id; here we just grab the latest.
  const nonce = mostRecentNonce();
  if (!nonce) {
    return res.status(400).json({ error: 'invalid_request', message: 'no nonce issued' });
  }

  try {
    const verified = await verifyResponse(jwt, {
      expectedAudience: RP_ORIGIN,
      expectedNonce: nonce,
      nowUnixSecs: Math.floor(Date.now() / 1000),
      maxIatSkewSecs: 120,
    });

    // Consume the nonce so it can't be replayed.
    nonces.delete(nonce);

    // Anchor on first sight + rollback check.
    const existing = users.get(verified.did);
    if (existing) {
      if (existing.genesis_roster_hash !== verified.genesisRosterHash) {
        return res.status(401).json({
          error: 'genesis_hash_mismatch',
          message: 'a different DID was previously seen with this identifier',
        });
      }
      try {
        checkRollback(verified, existing.last_seen_roster_version);
      } catch (e) {
        return res.status(401).json({
          error: e.code,
          message: e.message,
        });
      }
    }

    // Upsert.
    const now = Date.now();
    users.set(verified.did, {
      genesis_roster_hash: verified.genesisRosterHash,
      last_seen_roster_version: Math.max(
        existing?.last_seen_roster_version || 0,
        verified.currentVersion
      ),
      first_signed_in_at: existing?.first_signed_in_at || now,
      last_signed_in_at: now,
      email: verified.claims.email?.value || existing?.email || null,
      name: verified.claims.name?.value || existing?.name || null,
    });

    res.json({
      verified: true,
      did: verified.did,
      currentVersion: verified.currentVersion,
      genesisRosterHash: verified.genesisRosterHash,
      claims: verified.claims,
      iat: verified.iat,
      exp: verified.exp,
      // `aud` is what the SDK sent as `rpOrigin` and what the verifier
      // matched against `expectedAudience`. The demo's status card
      // renders it as a sanity-check value; without it the card
      // showed "Audience: undefined" after a successful verify.
      aud: verified.aud,
      is_returning_user: !!existing,
    });
  } catch (err) {
    if (err instanceof VerifyError) {
      return res.status(401).json({
        error: err.code,
        message: err.message,
      });
    }
    console.error('unexpected verify error', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── /api/dev/mock-jwt ─────────────────────────────────────────────────────
//
// DEV-ONLY. Stands in for the real `@matanetwork/sovereign-id` SDK's
// signIn() call when no MATA wallet is installed. The mock wallet
// produces a JWT using a deterministic in-process keypair. The
// verifier accepts it because the cryptography is real — only the
// signer's UX is fake.

app.post('/api/dev/mock-jwt', async (req, res) => {
  const { rpOrigin, nonce, claims, profile } = req.body;

  if (typeof rpOrigin !== 'string' || typeof nonce !== 'string' || !claims) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  try {
    const jwt = await mockWallet.signRequest(
      { rpOrigin, nonce, claims },
      profile || {}
    );
    res.json({
      jwt,
      surface: 'dev_mock',
      did: mockWallet.did,
    });
  } catch (err) {
    console.error('mock wallet sign failed', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ─── /api/whoami ───────────────────────────────────────────────────────────
//
// Convenience endpoint to inspect the demo's state.

app.get('/api/whoami', (_req, res) => {
  res.json({
    rpOrigin: RP_ORIGIN,
    walletDid: mockWallet.did,
    knownUsers: Array.from(users.entries()).map(([did, info]) => ({
      did,
      ...info,
    })),
    activeNonces: nonces.size,
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function mostRecentNonce() {
  let mostRecent = null;
  let bestTime = 0;
  for (const [nonce, { issued_at }] of nonces) {
    if (issued_at > bestTime) {
      mostRecent = nonce;
      bestTime = issued_at;
    }
  }
  return mostRecent;
}

// ─── Boot ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════╗');
  console.log('  ║   MATA Sovereign ID — Hello-World Demo                    ║');
  console.log('  ╠═══════════════════════════════════════════════════════════╣');
  console.log(`  ║   Open: http://localhost:${PORT}/`.padEnd(64) + '║');
  console.log('  ╚═══════════════════════════════════════════════════════════╝');
  console.log('');
});
