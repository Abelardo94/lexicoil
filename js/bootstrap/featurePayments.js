/* Stripe checkout / Pro activation UI */
(function () {
  function isSignedIn() {
    if (typeof Auth !== 'undefined' && Auth.isGuest && Auth.isGuest()) return false;
    if (typeof isAppAuthenticated === 'function') return isAppAuthenticated();
    return typeof Auth !== 'undefined' && Auth.hasSession && Auth.hasSession();
  }

  function payFetch(url, options = {}) {
    if (typeof lcApiFetch === 'function') return lcApiFetch(url, options);
    return fetch(url, {
      credentials: 'include',
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(typeof lcAuthHeaders === 'function' ? lcAuthHeaders() : {}),
        ...(options.headers || {}),
      },
    });
  }

  window.activatePro = async function () {
    if (typeof Auth !== 'undefined' && Auth.isGuest()) {
      closeUpgrade();
      switchTab('login');
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      setAMsg('Sign in or register to upgrade to Pro.');
      return;
    }
    if (!isSignedIn()) {
      closeUpgrade();
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      return;
    }
    try {
      await startStripeCheckout();
    } catch (e) {
      notify(
        e.message === 'login_required'
          ? 'Please sign in first.'
          : e.message === 'already_subscribed'
            ? 'You already have this plan. Use "Manage subscription" to change or cancel it.'
            : 'Checkout failed. Try again later.',
        'error',
        e.message === 'already_subscribed' ? 7000 : undefined,
      );
    }
  };

  window.openStripePortal = async function () {
    if (typeof Auth !== 'undefined' && Auth.isGuest()) {
      switchTab('login');
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      setAMsg('Sign in to manage your subscription.');
      return;
    }
    if (!isSignedIn()) {
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      return;
    }
    try {
      if (typeof startStripePortal !== 'function') throw new Error('portal_unavailable');
      await startStripePortal();
    } catch (e) {
      const msg =
        e.code === 'no_billing_account'
          ? S.user?.billingSource === 'manual'
            ? 'Your Pro plan was activated without Stripe billing. Contact support to manage it.'
            : 'No billing account found. Contact support if you subscribed with a different email.'
          : e.message === 'login_required'
            ? 'Please sign in first.'
            : 'Could not open billing portal. Try again later.';
      notify(msg, 'error', 6000);
    }
  };

  async function waitForProActivation(maxAttempts, delayMs) {
    maxAttempts = maxAttempts || 16;
    delayMs = delayMs || 500;
    for (let i = 0; i < maxAttempts; i++) {
      await Auth.bootstrap();
      if (isPro() && getQuotaMax() >= PRO_QUOTA) return true;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return isPro() && getQuotaMax() >= PRO_QUOTA;
  }

  window.activateProMax = async function () {
    if (typeof Auth !== 'undefined' && Auth.isGuest()) {
      closeUpgrade();
      switchTab('login');
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      setAMsg('Sign in or register to upgrade to Pro Max.');
      return;
    }
    if (!isSignedIn()) {
      closeUpgrade();
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      return;
    }
    try {
      await startStripeCheckout({ plan: 'pro_max' });
    } catch (e) {
      notify(
        e.message === 'login_required'
          ? 'Please sign in first.'
          : e.message === 'already_subscribed'
            ? 'You already have this plan. Use "Manage subscription" to change or cancel it.'
            : 'Checkout failed. Try again later.',
        'error',
        e.message === 'already_subscribed' ? 7000 : undefined,
      );
    }
  };

  window.handleUrlParams = async function () {
    const p = new URLSearchParams(location.search);
    if (p.get('credits') === '1') {
      const packCredits = Math.max(0, parseInt(p.get('pack_credits') || '0', 10) || 0);
      history.replaceState({}, '', location.pathname);
      if (typeof Auth !== 'undefined') await Auth.bootstrap();
      updQuotaUI();
      if (typeof refreshUserDropdown === 'function') refreshUserDropdown();
      const msg =
        packCredits > 0
          ? `You added ${packCredits} credits (they never expire).`
          : 'Credit pack purchased — credits added to your account.';
      notify(msg, 'success', 6000);
      return;
    }
    if (p.get('upgraded') === '1') {
      const sessionId = p.get('session_id') || '';
      history.replaceState({}, '', location.pathname);
      let activated = false;
      if (sessionId && typeof confirmStripePurchase === 'function') {
        try {
          await confirmStripePurchase(sessionId);
          activated = true;
        } catch (e) {
          lcDebug.warn('[upgrade] stripe-confirm failed, falling back to webhook poll:', e.message || e);
        }
      }
      if (!activated) activated = await waitForProActivation();
      updUserBtn();
      updQuotaUI();
      if (typeof refreshUserDropdown === 'function') refreshUserDropdown();
      if (activated) {
        notify(
          typeof PlanPricing !== 'undefined' ? PlanPricing.proActivatedToast() : "You're now Pro.",
          'success',
          6000,
        );
      } else {
        notify(
          'Payment received. Pro activation is still processing — refresh in a few seconds if needed.',
          'warn',
          6000,
        );
      }
    }
    if (p.get('cancelled') === '1') {
      history.replaceState({}, '', location.pathname);
      const el = document.getElementById('quotaHomeHint');
      if (el) el.textContent = 'Upgrade cancelled. You can upgrade anytime from the home screen.';
    }
    const resetToken = p.get('reset');
    if (resetToken) {
      history.replaceState({}, '', location.pathname);
      if (typeof showResetPasswordForm === 'function') showResetPasswordForm(resetToken);
    }
    if (p.get('emailVerified') === '1') {
      history.replaceState({}, '', location.pathname);
      if (typeof lcToast === 'function') lcToast('Email confirmed. You can sign in now.', 'ok', 6000);
      if (typeof switchTab === 'function') switchTab('login');
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
    }
  };

  window.startCreditCheckout = async function (pack) {
    if (typeof Auth !== 'undefined' && Auth.isGuest()) {
      switchTab('login');
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      return;
    }
    if (!isSignedIn()) {
      if (typeof showAuthOverlay === 'function') showAuthOverlay();
      return;
    }
    try {
      if (typeof LcAnalytics !== 'undefined') LcAnalytics.trackUpgradeClicked('credits');
      const res = await payFetch('/.netlify/functions/stripe-credit-checkout', {
        method: 'POST',
        body: JSON.stringify({ pack: Number(pack) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'checkout_failed');
      if (!data.url) throw new Error('checkout_failed');
      window.location.href = data.url;
    } catch (e) {
      notify('Could not start checkout. Try again later.', 'error');
    }
  };

  window.toggleAutoRecharge = async function (enabled) {
    if (!isSignedIn()) return;
    try {
      const res = await payFetch('/.netlify/functions/auth-prefs', {
        method: 'POST',
        body: JSON.stringify({ autoRechargeEnabled: !!enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'prefs_failed');
      if (typeof S !== 'undefined' && data.autoRecharge) {
        S.autoRecharge = data.autoRecharge;
      }
      notify(enabled ? 'Auto-recharge enabled.' : 'Auto-recharge disabled.', 'success', 4000);
    } catch (_) {
      notify('Could not save preference.', 'error');
      const el = document.getElementById('autoRechargeToggle');
      if (el) el.checked = !enabled;
    }
  };

  window.loadAutoRechargePref = async function () {
    if (!isSignedIn()) return;
    try {
      const res = await payFetch('/.netlify/functions/auth-prefs');
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.autoRecharge) {
        S.autoRecharge = data.autoRecharge;
        const el = document.getElementById('autoRechargeToggle');
        if (el) el.checked = !!data.autoRecharge.enabled;
      }
    } catch (_) {
      /* ignore */
    }
  };

  window.openCreditPackModal = function () {
    if (typeof showCreditPackModal === 'function') showCreditPackModal({ mode: 'browse' });
  };
})();
