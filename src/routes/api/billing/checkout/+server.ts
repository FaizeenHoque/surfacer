import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import DodoPayments from 'dodopayments';
import {
  createAuthedSupabase,
  getUserFromToken,
  getUserSubscriptionTracking,
  setUserSubscriptionTracking,
} from '$lib/server/chats';
import { findCreditPack, getDodoEnvironment } from '$lib/server/billing';
import {
  findActiveSubscriptionForUser,
  getSubscriptionById,
  isSubscriptionActiveLike,
} from '$lib/server/dodoBilling';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request, url }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const apiKey = env.DODO_PAYMENTS_API_KEY || '';
    if (!apiKey) {
      return json({ error: 'Missing DODO_PAYMENTS_API_KEY' }, { status: 500 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    const payload = await request.json().catch(() => ({}));
    const requestedPackId = typeof payload.packId === 'string' ? payload.packId : null;
    const selectedPack = findCreditPack(requestedPackId);

    if (!selectedPack) {
      return json(
        {
          error:
            'Credits pack is not configured. Set DODO_CREDITS_PRODUCT_ID (or DODO_PRODUCT_ID) in server env, and optionally DODO_CREDITS_PACK_CREDITS.',
        },
        { status: 400 }
      );
    }

    const dodo = new DodoPayments({
      bearerToken: apiKey,
      environment: getDodoEnvironment(),
    });

    if (selectedPack.interval && selectedPack.interval !== 'one_time') {
      const tracked = await getUserSubscriptionTracking(supabase, user.id);
      let existingSubscription = tracked?.subscriptionId
        ? await getSubscriptionById(dodo, tracked.subscriptionId)
        : null;

      if (existingSubscription && !isSubscriptionActiveLike(existingSubscription)) {
        existingSubscription = null;
      }

      if (!existingSubscription) {
        existingSubscription = await findActiveSubscriptionForUser(dodo, user.id, user.email || '');
      }

      if (existingSubscription) {
        await setUserSubscriptionTracking(
          supabase,
          user.id,
          existingSubscription.subscription_id,
          existingSubscription.status
        );

        return json(
          {
            error:
              'You already have an active subscription. Cancel the current subscription before purchasing another one.',
          },
          { status: 409 }
        );
      }
    }

    const origin = url.origin;
    const returnUrl = `${origin}/?billing=success`;
    const cancelUrl = `${origin}/?billing=cancelled`;

    const timeoutSession = await Promise.race([
      dodo.checkoutSessions.create({
        product_cart: [{ product_id: selectedPack.productId, quantity: 1 }],
        customer: {
          email: user.email || '',
        },
        return_url: returnUrl,
        cancel_url: cancelUrl,
        metadata: {
          app_user_id: user.id,
          app_user_email: user.email || '',
          credits_to_add: String(selectedPack.credits),
          credits_pack_id: selectedPack.id,
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Checkout request timed out')), 20_000)),
    ]);

    if (!timeoutSession.checkout_url) {
      return json({ error: 'Checkout URL was not returned by Dodo Payments.' }, { status: 502 });
    }

    return json({
      checkoutUrl: timeoutSession.checkout_url,
      sessionId: timeoutSession.session_id,
    });
  } catch (err: unknown) {
    const baseMessage =
      err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string'
          ? (err as { message: string }).message
          : 'Checkout creation failed';
    const message = /unauthorized/i.test(baseMessage)
      ? 'Dodo rejected credentials (401). Check DODO_PAYMENTS_API_KEY and DODO_PAYMENTS_ENVIRONMENT (test_mode/live_mode).'
      : baseMessage;
    return json({ error: message }, { status: 500 });
  }
};
