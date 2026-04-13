import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import DodoPayments from 'dodopayments';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { env } from '$env/dynamic/private';
import { getCreditsForPackId, getCreditsForProductId, getDodoEnvironment } from '$lib/server/billing';

const processedWebhookIds = new Map<string, number>();
const processedPaymentIds = new Map<string, number>();
const processedSubscriptionRenewalIds = new Map<string, number>();
const DEDUPE_WINDOW_MS = 1000 * 60 * 60 * 24;

function hasProcessed(map: Map<string, number>, key: string, now = Date.now()) {
  const seenAt = map.get(key);
  if (!seenAt) return false;
  if (now - seenAt > DEDUPE_WINDOW_MS) {
    map.delete(key);
    return false;
  }
  return true;
}

function markProcessed(map: Map<string, number>, key: string, now = Date.now()) {
  map.set(key, now);
  if (map.size < 5000) return;

  for (const [storedKey, ts] of map) {
    if (now - ts > DEDUPE_WINDOW_MS) {
      map.delete(storedKey);
    }
  }
}

function parsePositiveInt(value: string | undefined, fallback = 0) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function getString(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (typeof value !== 'string') return '';
  return value.trim();
}

function collectProductIds(payment: Record<string, unknown>) {
  const ids: string[] = [];

  const directProductId = typeof payment.product_id === 'string' ? payment.product_id.trim() : '';
  if (directProductId) ids.push(directProductId);

  const productCart = Array.isArray(payment.product_cart) ? payment.product_cart : [];
  for (const entry of productCart) {
    const id = typeof (entry as { product_id?: unknown }).product_id === 'string'
      ? String((entry as { product_id?: unknown }).product_id).trim()
      : '';
    if (id) ids.push(id);
  }

  return [...new Set(ids)];
}

function getRecord(value: unknown) {
  if (!value || typeof value !== 'object') return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

function normalizeSubscriptionStatus(value: string) {
  return value.trim().toLowerCase();
}

function extractSubscriptionIdFromPayment(payment: Record<string, unknown>) {
  const direct = getString(payment, 'subscription_id');
  if (direct) return direct;

  const subscription = getRecord(payment.subscription);
  return getString(subscription, 'subscription_id');
}

async function resolveUserIdFromCustomer(
  dodo: DodoPayments,
  customerId: string
) {
  if (!customerId) return '';
  try {
    const customer = await dodo.customers.retrieve(customerId);
    const metadata = getRecord(customer.metadata);
    return getString(metadata, 'app_user_id');
  } catch {
    return '';
  }
}

async function addCreditsToUser(userId: string, creditsToAdd: number) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY for webhook credit grants');
  }

  const supabase = createClient(PUBLIC_SUPABASE_URL, key);

  const profileLookup = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .maybeSingle();

  if (profileLookup.error || !profileLookup.data) {
    throw new Error(profileLookup.error?.message || 'Profile not found for webhook credit grant');
  }

  const rawCredits = profileLookup.data.credits;
  const currentCredits = typeof rawCredits === 'number'
    ? rawCredits
    : typeof rawCredits === 'string'
      ? Number(rawCredits) || 0
      : 0;
  const nextCredits = currentCredits + creditsToAdd;

  const updateResult = await supabase
    .from('profiles')
    .update({ credits: nextCredits })
    .eq('id', userId);

  if (updateResult.error) {
    throw new Error(updateResult.error.message);
  }
}

async function setUserSubscriptionTracking(userId: string, subscriptionId: string, subscriptionStatus?: string) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY for webhook subscription tracking');
  }

  const supabase = createClient(PUBLIC_SUPABASE_URL, key);
  const nextStatus = subscriptionStatus ? normalizeSubscriptionStatus(subscriptionStatus) : null;

  const updateResult = await supabase
    .from('profiles')
    .update({
      subscription_id: subscriptionId || null,
      subscription_status: nextStatus,
    })
    .eq('id', userId);

  if (updateResult.error) {
    throw new Error(updateResult.error.message);
  }
}

async function clearUserSubscriptionTracking(userId: string) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY for webhook subscription tracking');
  }

  const supabase = createClient(PUBLIC_SUPABASE_URL, key);
  const updateResult = await supabase
    .from('profiles')
    .update({
      subscription_id: null,
      subscription_status: null,
    })
    .eq('id', userId);

  if (updateResult.error) {
    throw new Error(updateResult.error.message);
  }
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const apiKey = env.DODO_PAYMENTS_API_KEY || '';
    const webhookKey = env.DODO_PAYMENTS_WEBHOOK_KEY || '';

    if (!apiKey || !webhookKey) {
      return json({ error: 'Dodo webhook is not configured' }, { status: 500 });
    }

    const rawBody = await request.text();
    const webhookId = request.headers.get('webhook-id') || '';
    const webhookSignature = request.headers.get('webhook-signature') || '';
    const webhookTimestamp = request.headers.get('webhook-timestamp') || '';

    const dodo = new DodoPayments({
      bearerToken: apiKey,
      webhookKey,
      environment: getDodoEnvironment(),
    });

    const event = dodo.webhooks.unwrap(rawBody, {
      headers: {
        'webhook-id': webhookId,
        'webhook-signature': webhookSignature,
        'webhook-timestamp': webhookTimestamp,
      },
    });

    const now = Date.now();
    if (webhookId && hasProcessed(processedWebhookIds, webhookId, now)) {
      return json({ ok: true, deduped: true });
    }

    if (event.type === 'payment.succeeded') {
      const payment = event.data as unknown as Record<string, unknown>;
      const paymentId = typeof payment.payment_id === 'string' ? payment.payment_id : '';

      if (paymentId && hasProcessed(processedPaymentIds, paymentId, now)) {
        if (webhookId) {
          markProcessed(processedWebhookIds, webhookId, now);
        }
        return json({ ok: true, deduped: true });
      }

      const metadata = getRecord(payment.metadata);
      const customer = getRecord(payment.customer);
      const customerMetadata = getRecord(customer.metadata);

      let userId =
        getString(metadata, 'app_user_id') ||
        getString(customerMetadata, 'app_user_id');

      if (!userId) {
        const customerId = getString(customer, 'customer_id');
        userId = await resolveUserIdFromCustomer(dodo, customerId);
      }

      const explicitCredits = parsePositiveInt(getString(metadata, 'credits_to_add'), 0);
      const packCredits = getCreditsForPackId(getString(metadata, 'credits_pack_id'));
      const productCredits = collectProductIds(payment)
        .map((productId) => getCreditsForProductId(productId))
        .find((credits) => credits > 0) || 0;

      const creditsToAdd = explicitCredits || packCredits || productCredits;

      if (!userId || creditsToAdd <= 0) {
        if (webhookId) {
          markProcessed(processedWebhookIds, webhookId, now);
        }
        if (paymentId) {
          markProcessed(processedPaymentIds, paymentId, now);
        }
        return json({ ok: true, ignored: true });
      }

      await addCreditsToUser(userId, creditsToAdd);

      const subscriptionId = extractSubscriptionIdFromPayment(payment);
      if (subscriptionId) {
        await setUserSubscriptionTracking(userId, subscriptionId, 'active');
      }

      if (webhookId) {
        markProcessed(processedWebhookIds, webhookId, now);
      }
      if (paymentId) {
        markProcessed(processedPaymentIds, paymentId, now);
      }

      return json({ ok: true });
    }

    if (event.type === 'subscription.renewed') {
      const subscription = event.data as unknown as Record<string, unknown>;
      const subscriptionId = getString(subscription, 'subscription_id');
      const nextBillingDate = getString(subscription, 'next_billing_date');
      const cycleKey = subscriptionId && nextBillingDate ? `${subscriptionId}:${nextBillingDate}` : '';

      if (cycleKey && hasProcessed(processedSubscriptionRenewalIds, cycleKey, now)) {
        if (webhookId) {
          markProcessed(processedWebhookIds, webhookId, now);
        }
        return json({ ok: true, deduped: true });
      }

      const metadata = getRecord(subscription.metadata);
      const customer = getRecord(subscription.customer);
      const customerMetadata = getRecord(customer.metadata);

      let userId =
        getString(metadata, 'app_user_id') ||
        getString(customerMetadata, 'app_user_id');

      if (!userId) {
        const customerId = getString(customer, 'customer_id');
        userId = await resolveUserIdFromCustomer(dodo, customerId);
      }

      const explicitCredits = parsePositiveInt(getString(metadata, 'credits_to_add'), 0);
      const packCredits = getCreditsForPackId(getString(metadata, 'credits_pack_id'));
      const productCredits = getCreditsForProductId(getString(subscription, 'product_id'));
      const creditsToAdd = explicitCredits || packCredits || productCredits;

      if (!userId || creditsToAdd <= 0) {
        if (webhookId) {
          markProcessed(processedWebhookIds, webhookId, now);
        }
        if (cycleKey) {
          markProcessed(processedSubscriptionRenewalIds, cycleKey, now);
        }
        return json({ ok: true, ignored: true });
      }

      await addCreditsToUser(userId, creditsToAdd);

      if (subscriptionId) {
        const status = getString(subscription, 'status') || 'active';
        await setUserSubscriptionTracking(userId, subscriptionId, status);
      }

      if (webhookId) {
        markProcessed(processedWebhookIds, webhookId, now);
      }
      if (cycleKey) {
        markProcessed(processedSubscriptionRenewalIds, cycleKey, now);
      }

      return json({ ok: true });
    }

    if (event.type.startsWith('subscription.')) {
      const subscription = event.data as unknown as Record<string, unknown>;
      const metadata = getRecord(subscription.metadata);
      const customer = getRecord(subscription.customer);
      const customerMetadata = getRecord(customer.metadata);

      let userId =
        getString(metadata, 'app_user_id') ||
        getString(customerMetadata, 'app_user_id');

      if (!userId) {
        const customerId = getString(customer, 'customer_id');
        userId = await resolveUserIdFromCustomer(dodo, customerId);
      }

      const subscriptionId = getString(subscription, 'subscription_id');
      const status = normalizeSubscriptionStatus(getString(subscription, 'status'));

      if (userId && subscriptionId) {
        if (status === 'active' || status === 'pending' || status === 'on_hold') {
          await setUserSubscriptionTracking(userId, subscriptionId, status);
        }

        if (status === 'cancelled' || status === 'expired' || status === 'failed') {
          await clearUserSubscriptionTracking(userId);
        }
      }

      if (webhookId) {
        markProcessed(processedWebhookIds, webhookId, now);
      }

      return json({ ok: true });
    }

    if (webhookId) {
      markProcessed(processedWebhookIds, webhookId, now);
    }
    return json({ ok: true, ignored: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Webhook processing failed';
    return json({ error: message }, { status: 400 });
  }
};
