import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import DodoPayments from 'dodopayments';
import { createAuthedSupabase, getUserFromToken } from '$lib/server/chats';
import { getDodoEnvironment } from '$lib/server/billing';
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
    if (!user.email) {
      return json({ error: 'User email is required to manage subscription' }, { status: 400 });
    }

    const dodo = new DodoPayments({
      bearerToken: apiKey,
      environment: getDodoEnvironment(),
    });

    const customersPage = await dodo.customers.list({
      email: user.email,
      page_number: 1,
      page_size: 1,
    });

    const customer = customersPage.items?.[0];
    if (!customer) {
      return json({ error: 'No billing customer found yet. Complete one checkout first.' }, { status: 404 });
    }

    const portal = await dodo.customers.customerPortal.create(customer.customer_id, {
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
