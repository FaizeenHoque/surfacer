import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  clearUserSubscriptionTracking,
  createAuthedSupabase,
  getUserFromToken,
  getUserSubscriptionTracking,
  setUserSubscriptionTracking,
} from '$lib/server/chats';
import {
  createDodoClient,
  findActiveSubscriptionForUser,
  getSubscriptionById,
  isSubscriptionActiveLike,
} from '$lib/server/dodoBilling';

export const GET: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    const dodo = createDodoClient();
    const tracked = await getUserSubscriptionTracking(supabase, user.id);

    let subscription = tracked?.subscriptionId
      ? await getSubscriptionById(dodo, tracked.subscriptionId)
      : null;

    if (subscription && !isSubscriptionActiveLike(subscription)) {
      await clearUserSubscriptionTracking(supabase, user.id);
      subscription = null;
    }

    if (!subscription) {
      subscription = await findActiveSubscriptionForUser(dodo, user.id, user.email || '');

      if (subscription?.subscription_id) {
        await setUserSubscriptionTracking(supabase, user.id, subscription.subscription_id, subscription.status);
      }
    }

    return json({
      hasActiveSubscription: Boolean(subscription && isSubscriptionActiveLike(subscription)),
      subscription: subscription
        ? {
            id: subscription.subscription_id,
            status: subscription.status,
            productId: subscription.product_id || null,
            nextBillingDate: subscription.next_billing_date || null,
            cancelAtNextBillingDate: Boolean(subscription.cancel_at_next_billing_date),
          }
        : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to load subscription status';
    return json({ error: message }, { status: 500 });
  }
};
