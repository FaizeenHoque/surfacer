import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createAuthedSupabase, getUserFromToken } from '$lib/server/chats';
import { createDodoClient, findActiveSubscriptionForUser } from '$lib/server/dodoBilling';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    const dodo = createDodoClient();
    const subscription = await findActiveSubscriptionForUser(dodo, user.id, user.email || '');

    if (!subscription?.subscription_id) {
      return json({ error: 'No active subscription found.' }, { status: 404 });
    }

    if (subscription.cancel_at_next_billing_date) {
      return json({ ok: true, alreadyScheduled: true });
    }

    await dodo.subscriptions.update(subscription.subscription_id, {
      cancel_at_next_billing_date: true,
      cancel_reason: 'cancelled_by_customer',
    });

    return json({ ok: true, cancelScheduled: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to cancel subscription';
    return json({ error: message }, { status: 500 });
  }
};
