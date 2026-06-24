/**
 * Client-side controller for the Sovereign ID hello-world demo.
 *
 * Imports `@matanetwork/sovereign-id` to demonstrate the production SDK
 * shape, but falls back to the dev-mock endpoint when no wallet is
 * detected so the demo runs without any platform install.
 */

// Browser can't resolve "@matanetwork/sovereign-id" without a bundler — load
// directly from the package src instead. The path is relative to the
// public root the server serves from.
import {
  signIn,
  hasExtension,
  resumePendingSignIn,
  SignInError,
} from '/sdk/index.js';

const RP_ORIGIN = window.location.origin;

const $status = document.getElementById('status');
const $trace = document.getElementById('trace');
const $extensionStatus = document.getElementById('extension-status');
const $signinReal = document.getElementById('signin-real');
const $signinMock = document.getElementById('signin-mock');

// ─── Extension detection ───────────────────────────────────────────────────

if (hasExtension()) {
  // `hasExtension()` only checks whether `window.__mata_mid__` is
  // installed by the extension's content script — it deliberately
  // doesn't expose vault-lock or signed-in state to every page
  // (that would be a fingerprinting vector). So "detected" means
  // "the extension is present"; the user may still need to unlock
  // it or sign in to their MATA account before sign-in can
  // complete.
  $extensionStatus.innerHTML =
    '✓ MATA extension detected. <strong>Make sure you\'re signed in to the MATA extension</strong> — click the MATA icon in your toolbar and unlock your vault before clicking Sign in with Sovereign ID.';
  $extensionStatus.style.color = 'var(--success)';
} else {
  $extensionStatus.innerHTML =
    '✗ MATA extension not detected. The "Sign in with Sovereign ID" button will attempt the native-app deep link, then show the install upsell (links to the Chrome Web Store). Use the dev-mock button to see the end-to-end flow without any install.';
  $extensionStatus.style.color = 'var(--warning)';
}

// ─── Trace UI ──────────────────────────────────────────────────────────────

function clearTrace() {
  $trace.innerHTML = '';
}

function trace(headline, detail = null, kind = '') {
  // First entry — drop the placeholder.
  if ($trace.querySelector('.muted')) clearTrace();

  const div = document.createElement('div');
  div.className = `trace-entry${kind ? ' ' + kind : ''}`;
  const head = document.createElement('p');
  head.className = 'trace-head';
  head.textContent = headline;
  div.appendChild(head);
  if (detail !== null && detail !== undefined) {
    const pre = document.createElement('pre');
    pre.className = 'trace-detail';
    pre.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    div.appendChild(pre);
  }
  $trace.appendChild(div);
}

// ─── Status UI ─────────────────────────────────────────────────────────────

function renderStatus(verified) {
  if (!verified) {
    $status.innerHTML = '<p class="muted">Not signed in.</p>';
    return;
  }
  const rows = [
    ['DID', verified.did, 'success'],
    ['Roster version', verified.currentVersion],
    ['Genesis hash', verified.genesisRosterHash.slice(0, 24) + '…'],
    ['Audience', verified.aud],
    ['Issued at', new Date(verified.iat * 1000).toLocaleString()],
    ['Expires at', new Date(verified.exp * 1000).toLocaleString()],
    [
      'Returning user',
      verified.is_returning_user ? 'yes' : 'no — first sign-in',
      verified.is_returning_user ? '' : 'success',
    ],
  ];
  let html = '';
  for (const [label, value, cls] of rows) {
    html += `<div class="status-row"><span class="label">${label}</span><span class="value ${cls || ''}">${escape(String(value))}</span></div>`;
  }
  if (verified.claims) {
    for (const [key, claim] of Object.entries(verified.claims)) {
      const v = claim.value;
      const extra = [];
      if (claim.verified_at_signup === true) extra.push('verified at signup');
      if (claim.formula_version) extra.push(`formula ${claim.formula_version}`);
      const suffix = extra.length ? ` (${extra.join(', ')})` : '';
      html += `<div class="status-row"><span class="label">${escape(key)}</span><span class="value">${escape(String(v))}${suffix}</span></div>`;
    }
  }
  $status.innerHTML = html;
}

function escape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Sign-in flows ─────────────────────────────────────────────────────────

async function performSignIn(useMock) {
  clearTrace();
  $signinReal.disabled = true;
  $signinMock.disabled = true;
  try {
    trace('1. Requesting a nonce', `GET ${RP_ORIGIN}/api/nonce`);
    const nonce = await fetch('/api/nonce').then((r) => r.text());
    trace('   ↳ Got nonce', nonce, 'success');

    const request = {
      rpOrigin: RP_ORIGIN,
      nonce,
      claims: {
        required: ['did'],
        optional: ['email', 'name', 'level_rating.trust'],
      },
    };

    let jwt;
    let surface;

    if (useMock) {
      trace(
        '2. Calling the dev-mock wallet',
        `POST ${RP_ORIGIN}/api/dev/mock-jwt\n` + JSON.stringify({ ...request, profile: defaultProfile() }, null, 2)
      );
      const mockResp = await fetch('/api/dev/mock-jwt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, profile: defaultProfile() }),
      }).then((r) => r.json());
      if (mockResp.error) {
        throw new Error(`mock JWT: ${mockResp.error}`);
      }
      jwt = mockResp.jwt;
      surface = mockResp.surface;
      trace(
        '   ↳ Mock wallet minted JWT',
        `surface=${surface}\ndid=${mockResp.did}\njwt=${jwt.slice(0, 80)}…`,
        'success'
      );
    } else {
      trace('2. Calling the real SDK signIn()', JSON.stringify(request, null, 2));
      // Surface a "what to do next" hint before the call awaits.
      // Without this, the trace looks stalled while the user is
      // actually expected to approve a consent prompt in the
      // extension's popup — which may or may not auto-open
      // depending on Chrome's MV3 chrome.action.openPopup() gating.
      trace(
        '   ↳ Waiting for your approval in the MATA extension',
        'If you don\'t see the consent popup automatically, click the MATA icon in your browser toolbar — the consent screen will be there waiting for you.\n\nIf the wallet is locked or you\'re signed out, the SDK will return wallet_unavailable shortly.'
      );
      const result = await signIn(request);
      jwt = result.jwt;
      surface = result.surface;
      trace(
        '   ↳ SDK returned JWT',
        `surface=${surface}\njwt=${jwt.slice(0, 80)}…`,
        'success'
      );
    }

    trace('3. Posting JWT to backend for verification', 'POST /api/verify');
    const verifyResp = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt }),
    }).then((r) => r.json());

    if (verifyResp.error) {
      trace(`   ↳ Verification rejected: ${verifyResp.error}`, verifyResp.message, 'error');
      throw new Error(`verify: ${verifyResp.error}`);
    }

    trace(
      '   ↳ ✓ Verified',
      `did=${verifyResp.did}\nversion=${verifyResp.currentVersion}\nis_returning_user=${verifyResp.is_returning_user}`,
      'success'
    );

    renderStatus(verifyResp);
  } catch (err) {
    if (err instanceof SignInError) {
      // Per-code hint so a stuck flow tells the user what to do next
      // instead of just printing the error code. Matches the
      // recommended-UX matrix in docs/sovereign-id/error-handling.md.
      const hint =
        {
          user_denied:
            'You clicked Deny in the consent screen. No data was shared.',
          upsell_canceled:
            'You dismissed the install upsell. Click Sign in again to retry.',
          wallet_unavailable:
            'The MATA extension is installed but not signed in or unlocked.\n→ Click the MATA icon in your toolbar, sign in, and unlock your vault.\n→ Then click Sign in with Sovereign ID again.',
          required_claim_unavailable:
            'Your MATA profile is missing a claim this site requires. Add it in the extension\'s profile settings, then try again.',
          timeout:
            'The consent flow took too long. Click the MATA icon in your toolbar — the consent screen may still be open there.',
          origin_mismatch:
            'The page\'s claimed origin did not match the browser tab\'s actual origin. This is unusual; refresh and try again.',
          invalid_request:
            'The sign-in request was malformed. This is a bug in this demo, not in your wallet.',
          internal_error:
            'Something unexpected went wrong inside the SDK. Check the browser console and the extension\'s service worker console for details.',
        }[err.code] || 'Branch on err.code to give specific guidance.';
      trace(`✗ SignInError: ${err.code}`, `${err.message}\n\n${hint}`, 'error');
    } else {
      trace('✗ Error', err.message || String(err), 'error');
    }
  } finally {
    $signinReal.disabled = false;
    $signinMock.disabled = false;
  }
}

function defaultProfile() {
  return {
    email: 'tim@example.com',
    name: 'Tim',
    trust_score: 82,
    security_score: 70,
    incentive_score: 10,
    paired_devices_count: 3,
  };
}

$signinReal.addEventListener('click', () => performSignIn(false));
$signinMock.addEventListener('click', () => performSignIn(true));

// ─── Resume-after-reload ───────────────────────────────────────────────────
//
// If the user installed MATA mid-flow and reloaded this page, the SDK
// stashed a resume token in sessionStorage. Calling
// `resumePendingSignIn()` at boot picks the flow back up automatically.

(async () => {
  try {
    const resumed = await resumePendingSignIn();
    if (resumed) {
      trace(
        '↻ Resumed sign-in after reload',
        `surface=${resumed.surface}\njwt=${resumed.jwt.slice(0, 80)}…`,
        'success'
      );
      // Hand the JWT to the verify endpoint just like the regular path.
      const verifyResp = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jwt: resumed.jwt }),
      }).then((r) => r.json());
      if (verifyResp.verified) {
        renderStatus(verifyResp);
      } else {
        trace(`   ↳ Verification rejected after resume: ${verifyResp.error}`, verifyResp.message, 'error');
      }
    }
  } catch (e) {
    trace('✗ Resume failed', e.message || String(e), 'error');
  }
})();
