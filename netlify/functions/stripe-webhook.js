'use strict';

// LexiCoil � stripe-webhook.js
// Receives Stripe webhook events and upgrades users to Pro on payment.
// Env vars required: STRIPE_WEBHOOK_SECRET

const { getStoreForEvent } = require('./lib/blobStore.js');
const { normalizeEmail } = require('./lib/authLib.js');
const { activateProForEmail, activateProMaxForEmail, revokeProForEmail, markPaymentPastDue, clearPaymentPastDue } = require('./lib/proUpgrade.js');
const { persistStripeCustomerId } = require('./lib/stripeLib.js');
const { addCreditTopups } = require('./lib/aiCredits.js');
const { sendPaymentFailedEmail } = require('./lib/email.js');
const {
  shouldRevokePro,
  shouldMarkPaymentWarning,
  isProActiveStatus,
  extractStripeEmail,
} = require('./lib/stripeSubscription.js');

function parseStripeEvent(rawBody, sigHeader, secret) {
  if (!secret) return { ok: false, error: 'missing_webhook_secret' };

  const parts = String(sigHeader || '').split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const ts = parts.t;
  const sig = parts.v1;

  if (!ts || !sig) return { ok: false, error: 'invalid_signature_header' };

  const tolerance = 5 * 60;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > tolerance) {
    return { ok: false, error: 'timestamp_too_old' };
  }

  const crypto = require('crypto');
  const signedPayload = `${ts}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(sig, 'hex');

  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return { ok: false, error: 'signature_mismatch' };
  }

  try {
    return { ok: true, event: JSON.parse(rawBody) };
  } catch (_) {
    return { ok: false, error: 'invalid_json' };
  }
}

function getRawBody(event) {
  if (event.isBase64Encoded && typeof event.body === 'string') {
    return Buffer.from(event.body, 'base64').toString('utf8');
  }
  return event.body || '';
}

function extractCreditPackMeta(obj) {
  if (!obj?.metadata) return null;
  if (obj.metadata.kind !== 'credit_pack') return null;
  const email = obj.metadata.email;
  const credits = Number(obj.metadata.credits);
  if (!email || !credits) return null;
  return { email: normalizeEmail(email), credits };
}

async function handleCreditPack(store, email, credits, idempotencyKey) {
  const result = await addCreditTopups(store, email, credits, idempotencyKey);
  if (result.ok) {
    console.log('[stripe-webhook] credit pack added:', email, credits, result.duplicate ? '(duplicate)' : '');
  }
  return result;
}

function extractEmail(obj) {
  return extractStripeEmail(obj);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not configured');
    return { statusCode: 503, body: 'Webhook not configured' };
  }

  const rawBody = getRawBody(event);
  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';

  const parsed = parseStripeEvent(rawBody, sigHeader, webhookSecret);
  if (!parsed.ok) {
    console.error('[stripe-webhook] Signature error:', parsed.error);
    return { statusCode: 400, body: `Webhook error: ${parsed.error}` };
  }

  const stripeEvent = parsed.event;
  const eventId = stripeEvent.id;
  console.log('[stripe-webhook] Event type:', stripeEvent.type, 'id:', eventId);

  const store = getStoreForEvent(event);
  const processedKey = `processed:${eventId}`;

  // A-1 fix: store.get() returns null on miss (never throws) � check the value, not the resolution
  const alreadySeen = await store.get(processedKey, { type: 'json' }).catch(() => null);
  if (alreadySeen) {
    return { statusCode: 200, body: 'already processed' };
  }

  let handled = false;

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data?.object;

      if (session?.metadata?.kind === 'credit_pack') {
        const meta = extractCreditPackMeta(session);
        if (meta) {
          const customerId = session.customer || null;
          if (customerId) await persistStripeCustomerId(store, meta.email, customerId);
          await handleCreditPack(store, meta.email, meta.credits, eventId);
          handled = true;
        }
      } else {
        const rawEmail = extractEmail(session);

        if (!rawEmail) {
          console.error('[stripe-webhook] No email in session metadata');
          return { statusCode: 200, body: 'ok' };
        }

        const email = normalizeEmail(rawEmail);
        const customerId = session.customer || null;
        if (customerId) await persistStripeCustomerId(store, email, customerId);

        const plan = session.metadata?.plan === 'pro_max' ? 'pro_max' : 'pro';
        const activate =
          plan === 'pro_max' ? activateProMaxForEmail : activateProForEmail;
        const result = await activate(store, email, {
          sendEmail: plan === 'pro',
          stripeCustomerId: customerId || undefined,
        });
        if (!result.ok) {
          console.error('[stripe-webhook] Upgrade failed:', result.error, email);
          return { statusCode: 200, body: 'ok' };
        }

        console.log('[stripe-webhook] Upgraded to', plan + ':', email);
        handled = true;
      }
    } else if (
      stripeEvent.type === 'payment_intent.succeeded' ||
      stripeEvent.type === 'charge.succeeded'
    ) {
      const obj = stripeEvent.data?.object;
      const meta = extractCreditPackMeta(obj);
      if (meta) {
        // A charge carries its PaymentIntent's metadata: key both events on the
        // PaymentIntent id (auto-recharge credits it under pi.id too) or a pack is
        // credited twice.
        const idem =
          (stripeEvent.type === 'charge.succeeded' && typeof obj.payment_intent === 'string'
            ? obj.payment_intent
            : obj.id) || eventId;
        await handleCreditPack(store, meta.email, meta.credits, idem);
        handled = true;
      }
    } else if (stripeEvent.type === 'customer.subscription.deleted') {
      const subscription = stripeEvent.data?.object;
      const rawEmail = extractEmail(subscription);

      if (!rawEmail) {
        console.error('[stripe-webhook] No email in subscription metadata');
        return { statusCode: 200, body: 'ok' };
      }

      const result = await revokeProForEmail(store, rawEmail, { reason: 'subscription_deleted' });
      if (!result.ok) {
        console.error('[stripe-webhook] User not found for subscription deletion:', rawEmail);
        return { statusCode: 200, body: 'ok' };
      }

      console.log('[stripe-webhook] Revoked Pro:', rawEmail);
      handled = true;
    } else if (stripeEvent.type === 'customer.subscription.updated') {
      const subscription = stripeEvent.data?.object;
      const status = subscription?.status;
      const rawEmail = extractEmail(subscription);

      if (rawEmail && status) {
        const email = normalizeEmail(rawEmail);

        if (shouldRevokePro(status)) {
          await revokeProForEmail(store, email, { reason: `subscription_${status}` });
          console.log('[stripe-webhook] Revoked Pro (subscription.updated):', email, status);
        } else if (shouldMarkPaymentWarning(status)) {
          await markPaymentPastDue(store, email, { status });
          console.log('[stripe-webhook] Payment grace (subscription.updated):', email, status);
        } else if (isProActiveStatus(status)) {
          await clearPaymentPastDue(store, email);
        }
      }
      handled = true;
    } else if (stripeEvent.type === 'charge.refunded') {
      const charge = stripeEvent.data?.object;
      const rawEmail = extractEmail(charge);

      if (charge?.metadata?.kind === 'credit_pack') {
        // Refunding a credit pack must not take away a subscription the user still pays.
        console.warn('[stripe-webhook] charge.refunded for a credit pack — plan untouched:', rawEmail || '(no email)');
      } else if (rawEmail) {
        const email = normalizeEmail(rawEmail);
        const result = await revokeProForEmail(store, email, { reason: 'charge_refunded' });
        if (result.ok) {
          console.log('[stripe-webhook] Revoked Pro (charge.refunded):', email, 'refunded:', charge?.amount_refunded);
        } else {
          console.warn('[stripe-webhook] charge.refunded — user not found or already free:', email);
        }
      } else {
        console.warn('[stripe-webhook] charge.refunded without email');
      }
      handled = true;
    } else if (stripeEvent.type === 'invoice.payment_failed') {
      const invoice = stripeEvent.data?.object;
      const rawEmail = extractEmail(invoice);

      if (rawEmail) {
        const email = normalizeEmail(rawEmail);
        const marked = await markPaymentPastDue(store, email, {
          invoiceId: invoice?.id || null,
          status: 'payment_failed',
        });

        if (marked.ok) {
          const sendEmail = !marked.alreadyWarned || marked.priorInvoiceId !== invoice?.id;
          if (sendEmail) {
            try {
              await sendPaymentFailedEmail(email, marked.user?.name || email.split('@')[0]);
            } catch (err) {
              console.error('[stripe-webhook] payment failed email error:', err.message);
            }
          }
          console.log('[stripe-webhook] Payment failed � Pro kept, warning set:', email);
        }
      } else {
        console.warn('[stripe-webhook] invoice.payment_failed without email');
      }
      handled = true;
    }

    // Mark as processed regardless � even ignored event types should not be replayed
    await store.setJSON(processedKey, { ts: Date.now(), type: stripeEvent.type }).catch(() => {});
  } catch (err) {
    console.error('[stripe-webhook] Error processing event:', err);
    return { statusCode: 500, body: 'Internal error' };
  }

  return { statusCode: 200, body: 'ok' };
};
