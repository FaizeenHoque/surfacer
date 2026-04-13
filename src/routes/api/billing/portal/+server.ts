import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createAuthedSupabase, getUserFromToken } from '$lib/server/chats';
import { createDodoClient, findActiveSubscriptionForUser, findCustomerIdByEmail } from '$lib/server/dodoBilling';

export const POST: RequestHandler = async ({ request, url }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);
    if (!user.email) {
      return json({ error: 'User email is required to manage subscription' }, { status: 400 });
    }

    const dodo = createDodoClient();

    let customerId = await findCustomerIdByEmail(dodo, user.email || '');
    if (!customerId) {
      const activeSubscription = await findActiveSubscriptionForUser(dodo, user.id, user.email || '');
      customerId = activeSubscription?.customer?.customer_id || '';
    }

    if (!customerId) {
      return json(
        { error: 'No billing customer found yet. Complete a paid checkout with this account first.' },
        { status: 404 }
      );
    }

    const portal = await dodo.customers.customerPortal.create(customerId, {
      return_url: `${url.origin}/?billing=portal`,
    });

    if (!portal.link) {
      return json({ error: 'Could not create billing portal link' }, { status: 502 });
    }

    return json({ url: portal.link });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to open billing portal';
    return json({ error: message }, { status: 500 });
  }
};
