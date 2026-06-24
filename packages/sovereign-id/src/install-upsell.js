/**
 * Install upsell — the SDK's "no wallet installed" fallback UI.
 *
 * Phase 4 of the mID Mission. When `signIn()` can't reach the extension
 * (no `window.__mata_mid__` global) AND the native-app deep link
 * doesn't get answered within ~1.5s, the SDK shows this overlay
 * instead of throwing `no_wallet_installed` to the RP. The overlay:
 *
 *  1. Tells the user MATA needs to be installed.
 *  2. Surfaces the right install link for the user's browser / OS.
 *  3. Polls `hasExtension()` once a second — when the user installs
 *     the extension in a new tab and comes back, the overlay detects
 *     the new `window.__mata_mid__` and auto-resumes the sign-in.
 *  4. Lets the user click "Continue" to manually retry, or "Cancel"
 *     to reject the sign-in.
 *
 * ## Why Shadow DOM
 *
 * The RP's page has unknown CSS. A naked `<div>` would inherit the
 * page's font, get hidden by aggressive `body *` rules, or worse —
 * be skinnable by a malicious RP. Shadow DOM gives us style isolation:
 * the overlay always looks the same regardless of where it mounts.
 *
 * ## What we do NOT do
 *
 * - **No fingerprinting.** Browser detection uses `navigator.userAgent`
 *   only for choosing the right install CTA — we never report it.
 * - **No tracking pixels.** The overlay is purely client-side.
 * - **No redirect.** v1 stays inline. A future "hosted upsell page"
 *   is possible (would let us A/B install conversion) but the inline
 *   modal keeps the RP page in control and avoids a third-party
 *   redirect on the critical sign-in path.
 */

const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/mata-digital-freedom-tool/fdpehkhlkfdmodfdjfjfaikaalabgimg';

/** Where the upsell sends the user when they click "create your account". */
const MATA_SIGNUP_URL = 'https://my.mata.network/signup';

/**
 * Extract a sensible default referral code from an RP origin. Returns
 * the bare hostname (no scheme, no port, no path) — e.g.
 * `"https://acme.com"` → `"acme.com"`, `"http://localhost:3000"` →
 * `"localhost"`. The MATA signup flow reads `?ref=` verbatim and
 * stores it under the `mata_ref` cookie + `referral_code` Supabase
 * field, so downstream attribution sees the RP's domain directly.
 *
 * Returns `null` when the origin can't be parsed — caller may want
 * to omit the ref entirely in that case.
 *
 * @param {string} rpOrigin
 * @returns {string | null}
 */
export function defaultRefFromOrigin(rpOrigin) {
  if (typeof rpOrigin !== 'string' || rpOrigin.length === 0) return null;
  try {
    const url = new URL(rpOrigin);
    return url.hostname || null;
  } catch (_) {
    return null;
  }
}

/**
 * Append `?ref=<code>` (or `&ref=<code>`) to a URL, preserving any
 * existing query string. Used to attach the referral on both the
 * install CTA and the signup link in the upsell modal.
 *
 * @internal
 */
function appendRef(url, ref) {
  if (!ref) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}ref=${encodeURIComponent(ref)}`;
}

/**
 * One of the CTAs the upsell can present. Pick by browser/OS.
 *
 * @typedef {object} InstallCta
 * @property {string} label - Button text (e.g. "Install MATA for Chrome")
 * @property {string} url - Where the button navigates to
 * @property {string} hint - Sub-text under the CTA (e.g. "Opens the Chrome Web Store in a new tab")
 */

/**
 * Detect the browser/OS and pick the right install CTA.
 *
 * @returns {InstallCta}
 */
export function pickInstallCta() {
  if (typeof navigator === 'undefined') {
    return chromeExtensionCta();
  }
  const ua = navigator.userAgent || '';

  // Mobile: Chrome on Android, Safari on iOS. The Chrome extension
  // doesn't run on mobile Chrome; deep-link to the native app once
  // those listings exist. Until then, mobile users see a clear
  // "MATA isn't on mobile yet" message rather than a broken link.
  if (/Android/i.test(ua)) {
    return {
      label: 'MATA is coming to Android',
      url: 'https://my.mata.network/',
      hint: 'Open mata.network for updates.',
    };
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return {
      label: 'MATA is coming to iOS',
      url: 'https://my.mata.network/',
      hint: 'Open mata.network for updates.',
    };
  }

  // Desktop: pick a CTA per browser. Chrome / Edge / Brave / Arc /
  // Opera all support Chrome Web Store extensions.
  if (/Chrome|CriOS|Edg|OPR|Brave/i.test(ua) && !/Firefox/i.test(ua)) {
    return chromeExtensionCta();
  }
  if (/Firefox/i.test(ua)) {
    return {
      label: 'MATA is coming to Firefox',
      url: 'https://my.mata.network/',
      hint: 'For now, use Chrome / Edge / Brave / Arc / Opera, or install the desktop app.',
    };
  }
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) {
    return {
      label: 'MATA is coming to Safari',
      url: 'https://my.mata.network/',
      hint: 'For now, use Chrome / Edge / Brave / Arc / Opera, or install the desktop app.',
    };
  }
  // Fallback — assume Chromium-flavored. The Web Store fails gracefully
  // for genuinely-unsupported browsers (they show their own "this won't
  // work here" page).
  return chromeExtensionCta();
}

function chromeExtensionCta() {
  return {
    label: 'Install MATA from the Chrome Web Store',
    url: CHROME_WEB_STORE_URL,
    hint: 'Opens in a new tab. After installing, this page will detect MATA automatically.',
  };
}

/**
 * Render the install upsell overlay. Returns a Promise that resolves
 * with one of:
 *
 * - `"installed"` — the upsell detected (via polling) that the
 *   extension is now installed. The caller should retry `signIn()`.
 * - `"canceled"` — the user clicked Cancel or pressed Escape.
 *
 * The overlay polls `hasExtensionFn()` (defaults to a check of
 * `window.__mata_mid__`) once a second. The Promise lives until one
 * of those terminal states fires.
 *
 * @param {object} options
 * @param {string} options.rpOrigin - shown prominently as the
 *     requesting RP.
 * @param {() => boolean} [options.hasExtensionFn] - inversion-of-control
 *     hook so the SDK's `hasExtension()` is used in production +
 *     tests can stub it.
 * @param {InstallCta} [options.cta] - override the auto-picked CTA.
 * @param {number} [options.pollIntervalMs] - default 1000.
 * @param {string | null} [options.ref] - referral code stamped onto
 *     the install CTA and the signup link. Defaults to the hostname
 *     extracted from `rpOrigin` (e.g., `"acme.com"`), so RPs get
 *     attribution by default. Pass `null` to disable, or a custom
 *     string to override (e.g., a configured MATA referral code).
 *     Follows the existing `?ref=` convention captured by
 *     [my.mata.network](https://my.mata.network)'s welcome view.
 * @returns {Promise<"installed" | "canceled">}
 */
export function showInstallUpsell(options) {
  const rpOrigin = options.rpOrigin || 'this site';
  const hasExtensionFn = options.hasExtensionFn || defaultHasExtension;
  const cta = options.cta || pickInstallCta();
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  // Default: derive the ref code from the RP's domain so RPs get
  // attribution without any extra wiring. Pass `null` to disable.
  const ref =
    options.ref === undefined
      ? defaultRefFromOrigin(options.rpOrigin)
      : options.ref;
  // Apply ref to both outbound URLs. Chrome Web Store strips unknown
  // params on its own redirect, but stamping it costs nothing and
  // keeps the future option open if the store starts honoring it.
  const installUrl = appendRef(cta.url, ref);
  const signupUrl = appendRef(MATA_SIGNUP_URL, ref);
  const resolvedCta = { ...cta, url: installUrl };

  // Already detected? Skip the modal entirely. Saves a flash.
  // Check this BEFORE the document-existence guard so server-side
  // tests with a stubbed `hasExtensionFn` still see the right
  // short-circuit.
  if (hasExtensionFn()) {
    return Promise.resolve('installed');
  }

  if (typeof document === 'undefined') {
    // Server-context safety — there's nothing to render.
    return Promise.resolve('canceled');
  }

  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.setAttribute('data-mata-mid-upsell', '');
    // Maximum z — RPs can layer their own modals, this should win.
    host.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647;';
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = upsellMarkup({ rpOrigin, cta: resolvedCta, signupUrl });

    let pollHandle = null;
    let escHandler = null;
    let trapHandler = null;
    let resolved = false;

    // Save the element that had focus before the modal opened so
    // we can restore it on close — standard accessible-modal
    // behavior. Without this, dismissing the modal leaves focus on
    // <body>, which is disorienting for keyboard + screen-reader
    // users.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (pollHandle !== null) clearInterval(pollHandle);
      if (escHandler !== null) document.removeEventListener('keydown', escHandler);
      if (trapHandler !== null) host.removeEventListener('keydown', trapHandler, true);
      try {
        host.remove();
      } catch (_) {
        /* best-effort */
      }
      // Restore focus to wherever it was before we opened. Skip if
      // the element is no longer in the document (e.g. RP nav-ed
      // away and back).
      if (previouslyFocused && document.contains(previouslyFocused)) {
        try {
          previouslyFocused.focus();
        } catch (_) {
          /* best-effort */
        }
      }
      resolve(result);
    };

    // Wire button handlers.
    const installBtn = shadow.querySelector('[data-action="install"]');
    const continueBtn = shadow.querySelector('[data-action="continue"]');
    const cancelBtn = shadow.querySelector('[data-action="cancel"]');
    const backdrop = shadow.querySelector('[data-role="backdrop"]');

    if (installBtn) {
      installBtn.addEventListener('click', () => {
        // Open the install URL in a new tab so this page stays open
        // (the polling needs the current tab alive to detect the
        // extension once the user comes back).
        window.open(resolvedCta.url, '_blank', 'noopener,noreferrer');
      });
    }
    if (continueBtn) {
      continueBtn.addEventListener('click', () => {
        if (hasExtensionFn()) {
          finish('installed');
        } else {
          flashContinueHint(shadow);
        }
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => finish('canceled'));
    }
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        // Only fire on direct backdrop clicks, not bubbled clicks
        // from the dialog content.
        if (e.target === backdrop) finish('canceled');
      });
    }

    // Escape key cancels.
    escHandler = (e) => {
      if (e.key === 'Escape') finish('canceled');
    };
    document.addEventListener('keydown', escHandler);

    // Focus trap. Modals MUST keep keyboard focus inside themselves
    // for accessibility compliance — without this, Tab eventually
    // escapes into the RP's underlying page (which is now
    // inert-but-not-actually-inert behind the backdrop). We listen
    // on `host` in capture phase so Tab is intercepted before the
    // browser's native focus move runs.
    trapHandler = (e) => {
      if (e.key !== 'Tab') return;
      const focusables = collectFocusables(shadow);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // `shadow.activeElement` is the focused element inside the
      // shadow tree (the document's activeElement is the host).
      const active = shadow.activeElement;
      if (e.shiftKey) {
        // Shift+Tab on first → wrap to last.
        if (active === first || !focusables.includes(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab on last → wrap to first.
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    host.addEventListener('keydown', trapHandler, true);

    // Move initial focus into the dialog. Default to the install
    // button (primary action) — that matches the visual hierarchy.
    // Wrapped in `requestAnimationFrame` so the dialog's open
    // animation has a frame to settle; otherwise some browsers
    // refuse to focus elements that just became visible.
    requestAnimationFrame(() => {
      const focusables = collectFocusables(shadow);
      if (focusables.length > 0) {
        try {
          focusables[0].focus();
        } catch (_) {
          /* best-effort */
        }
      }
    });

    // Poll for the extension. Once the user installs in a new tab and
    // returns to this tab, the next poll detects `window.__mata_mid__`
    // and auto-resumes the sign-in.
    pollHandle = setInterval(() => {
      if (hasExtensionFn()) {
        finish('installed');
      }
    }, pollIntervalMs);
  });
}

/**
 * Find the focusable elements inside the dialog's shadow tree, in
 * tab order. Buttons + anchors with `href` cover everything the
 * upsell ships today; the broader selector list is here so future
 * additions (text inputs, custom-tabindex elements) work without a
 * change to this helper.
 *
 * @internal
 */
function collectFocusables(shadow) {
  const dialog = shadow.querySelector('.dialog');
  if (!dialog) return [];
  const selector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(dialog.querySelectorAll(selector)).filter((el) => {
    // Skip elements that are visually hidden (display:none) or
    // explicitly inert. We use offsetParent === null as a fast
    // proxy for "not laid out / not visible." Doesn't catch
    // visibility:hidden, but the upsell never renders such
    // elements.
    return el.offsetParent !== null;
  });
}

/**
 * The runtime's default extension probe. Mirrors `hasExtension()` from
 * the SDK index — kept inline so install-upsell.js can be imported
 * standalone (e.g. for visual review).
 *
 * @internal
 */
function defaultHasExtension() {
  return (
    typeof window !== 'undefined' &&
    typeof window['__mata_mid__'] === 'object' &&
    window['__mata_mid__'] !== null &&
    window['__mata_mid__'].version === 1
  );
}

/**
 * Briefly highlight the polling hint when the user clicks Continue
 * but the extension isn't detected yet. Helps them understand why
 * nothing happened.
 *
 * @internal
 */
function flashContinueHint(shadow) {
  const hint = shadow.querySelector('[data-role="continue-hint"]');
  if (!hint) return;
  hint.classList.remove('flash');
  // Restart the CSS animation by forcing a reflow.
  void hint.offsetWidth;
  hint.classList.add('flash');
}

/**
 * The actual HTML the Shadow DOM renders. Inlined CSS keeps the
 * package single-file and avoids loader configuration on the RP side.
 *
 * @internal
 */
function upsellMarkup({ rpOrigin, cta, signupUrl }) {
  // Strip any HTML that might appear in rpOrigin / cta. They're
  // already validated upstream but defense-in-depth is cheap.
  const safe = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      [data-role="backdrop"] {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #1a1a1a;
        animation: fade-in 0.18s ease-out;
      }
      @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
      .dialog {
        background: #fff;
        border-radius: 12px;
        padding: 28px;
        max-width: 460px;
        width: calc(100% - 32px);
        box-shadow: 0 24px 64px rgba(0, 0, 0, 0.25);
        animation: slide-up 0.22s ease-out;
      }
      @keyframes slide-up {
        from { transform: translateY(12px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      h2 {
        margin: 0 0 4px;
        font-size: 1.25rem;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .rp {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.92rem;
        color: #555;
        word-break: break-all;
      }
      p {
        margin: 14px 0 0;
        line-height: 1.5;
        font-size: 0.95rem;
        color: #333;
      }
      .actions {
        margin-top: 22px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .btn {
        font: inherit;
        font-weight: 500;
        padding: 11px 18px;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        transition: background 0.12s, opacity 0.12s;
        text-align: center;
        text-decoration: none;
        display: inline-block;
      }
      .btn-primary { background: #2563eb; color: #fff; }
      .btn-primary:hover { background: #1d4ed8; }
      .btn-secondary {
        background: #fff;
        color: #1a1a1a;
        border: 1px solid #d0d0d0;
      }
      .btn-secondary:hover { background: #f6f6f6; }
      .btn-tertiary {
        background: transparent;
        color: #555;
        padding: 8px;
        font-size: 0.88rem;
      }
      .btn-tertiary:hover { color: #1a1a1a; }
      /* Keyboard focus ring. :focus-visible so mouse users don't
         see a ring on click but keyboard / screen-reader users do —
         standard accessible-modal practice. */
      .btn:focus-visible,
      .signup-line a:focus-visible {
        outline: 2px solid #2563eb;
        outline-offset: 2px;
      }
      .cta-hint {
        margin: 6px 0 0;
        font-size: 0.82rem;
        color: #777;
        text-align: center;
      }
      .row {
        display: flex;
        gap: 8px;
      }
      .row .btn { flex: 1; }
      .continue-hint {
        margin: 12px 0 0;
        text-align: center;
        font-size: 0.84rem;
        color: #888;
      }
      .continue-hint.flash {
        animation: flash-warn 0.6s ease-out;
      }
      @keyframes flash-warn {
        0%   { color: #888; }
        40%  { color: #b45309; }
        100% { color: #888; }
      }
      .signup-line {
        margin: 14px 0 0;
        padding-top: 14px;
        border-top: 1px solid #eee;
        font-size: 0.88rem;
        color: #555;
        text-align: center;
      }
      .signup-line a {
        color: #2563eb;
        text-decoration: none;
      }
      .signup-line a:hover { text-decoration: underline; }
    </style>
    <div data-role="backdrop" role="dialog" aria-modal="true" aria-labelledby="mata-mid-title">
      <div class="dialog">
        <h2 id="mata-mid-title">Sign in with Sovereign ID</h2>
        <div class="rp">${safe(rpOrigin)}</div>

        <p>
          To sign in here, install <strong>MATA</strong>. Your wallet stays
          on your device — MATA never sees who you are or where you sign in.
        </p>

        <div class="actions">
          <button class="btn btn-primary" data-action="install">${safe(cta.label)}</button>
          <p class="cta-hint">${safe(cta.hint)}</p>

          <div class="row">
            <button class="btn btn-secondary" data-action="continue">I've installed it</button>
            <button class="btn btn-secondary" data-action="cancel">Cancel</button>
          </div>
          <p class="continue-hint" data-role="continue-hint">
            Watching for MATA — this will continue automatically once installed.
          </p>
        </div>

        <p class="signup-line">
          New to MATA? After installing, the extension will walk you through
          <a href="${safe(signupUrl)}" target="_blank" rel="noopener noreferrer">
            creating your account
          </a>.
        </p>
      </div>
    </div>
  `;
}
