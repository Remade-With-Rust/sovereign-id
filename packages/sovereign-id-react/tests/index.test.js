/**
 * @matanetwork/sovereign-id-react — package tests.
 *
 * `node --test tests/index.test.js`. The hooks themselves run inside
 * React and exercise `window.sessionStorage` etc., so the DOM-driven
 * behavior is browser-test territory (the hello-world demo + the
 * SOAK runbook cover that). These tests focus on the static surface:
 * exports exist and are the right shape, re-exports from the core
 * SDK resolve, package.json metadata makes sense.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Module exports ────────────────────────────────────────────────────────

test('exports SignInButton, useSignIn, useResumePendingSignIn as functions', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.SignInButton, 'function');
  assert.equal(typeof mod.useSignIn, 'function');
  assert.equal(typeof mod.useResumePendingSignIn, 'function');
});

test('re-exports SignInError and error-code constants from the core SDK', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.SignInError, 'function');
  assert.equal(mod.ERR_USER_DENIED, 'user_denied');
  assert.equal(mod.ERR_UPSELL_CANCELED, 'upsell_canceled');
  assert.equal(mod.ERR_NO_WALLET_INSTALLED, 'no_wallet_installed');
  assert.equal(mod.ERR_INVALID_REQUEST, 'invalid_request');
  assert.equal(mod.ERR_TIMEOUT, 'timeout');
});

test('re-exports core SDK helpers (signIn, hasExtension, etc.)', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.signIn, 'function');
  assert.equal(typeof mod.hasExtension, 'function');
  assert.equal(typeof mod.resumePendingSignIn, 'function');
  assert.equal(typeof mod.clearPendingSignIn, 'function');
  assert.equal(typeof mod.showInstallUpsell, 'function');
  assert.equal(typeof mod.pickInstallCta, 'function');
  assert.equal(typeof mod.defaultRefFromOrigin, 'function');
});

test('re-exports wire-format constants verbatim', async () => {
  const mod = await import('../src/index.js');
  assert.equal(mod.PROTOCOL_VERSION, 1);
  assert.equal(mod.WINDOW_MID_GLOBAL, '__mata_mid__');
  assert.equal(mod.MESSAGE_DISCRIMINATOR, '__mata_mid_v1');
  assert.equal(mod.URL_SCHEME, 'mata-mid');
});

test('defaultRefFromOrigin behavior matches the core SDK', async () => {
  const { defaultRefFromOrigin } = await import('../src/index.js');
  assert.equal(defaultRefFromOrigin('https://acme.com'), 'acme.com');
  assert.equal(defaultRefFromOrigin('http://localhost:3000'), 'localhost');
  assert.equal(defaultRefFromOrigin('not a url'), null);
});

// ─── package.json sanity ───────────────────────────────────────────────────

test('package.json declares correct name and peer deps', async () => {
  const fs = await import('node:fs/promises');
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(await fs.readFile(url, 'utf8'));
  assert.equal(pkg.name, '@matanetwork/sovereign-id-react');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, 'src/index.js');
  assert.equal(pkg.types, 'src/index.d.ts');
  assert.equal(pkg.sideEffects, false);

  // Peer dep correctness — the SDK + React must be peers, not bundled.
  assert.ok(pkg.peerDependencies);
  assert.ok(pkg.peerDependencies['@matanetwork/sovereign-id']);
  assert.ok(pkg.peerDependencies['react']);
  // Reasonable range: ^0.1.x for the SDK, >=17 for React.
  assert.match(pkg.peerDependencies['react'], /17|18|19|>=/);
});

test('package.json exports field points at the same files as main/types', async () => {
  const fs = await import('node:fs/promises');
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(await fs.readFile(url, 'utf8'));
  assert.deepEqual(pkg.exports, {
    '.': {
      types: './src/index.d.ts',
      import: './src/index.js',
    },
  });
});

// ─── Hook smoke (no DOM): just ensure they can be imported and bound ────

test('hooks can be imported from their own files (not just re-exported)', async () => {
  const a = await import('../src/useSignIn.js');
  const b = await import('../src/useResumePendingSignIn.js');
  const c = await import('../src/SignInButton.js');
  assert.equal(typeof a.useSignIn, 'function');
  assert.equal(typeof b.useResumePendingSignIn, 'function');
  assert.equal(typeof c.SignInButton, 'function');
});
