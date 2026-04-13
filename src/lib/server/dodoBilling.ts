import DodoPayments from 'dodopayments';
import { env } from '$env/dynamic/private';
import { getDodoEnvironment } from '$lib/server/billing';

type BasicSubscription = {
  subscription_id: string;
  status: 'pending' | 'active' | 'on_hold' | 'cancelled' | 'failed' | 'expired';
  cancel_at_next_billing_date?: boolean;
  next_billing_date?: string;
  product_id?: string;
  metadata?: Record<string, unknown>;
  customer?: {
    customer_id?: string;
    email?: string;
  };
};

const ACTIVE_STATUSES: Array<BasicSubscription['status']> = ['active', 'pending', 'on_hold'];

export function createDodoClient() {
  const apiKey = env.DODO_PAYMENTS_API_KEY || '';
  if (!apiKey) {
    throw new Error('Missing DODO_PAYMENTS_API_KEY');
  }

  return new DodoPayments({
    bearerToken: apiKey,
    environment: getDodoEnvironment(),
  });
}

function normalizeEmail(value: string | undefined) {
  return (value || '').trim().toLowerCase();
}

function metadataUserId(subscription: BasicSubscription) {
  const metadata = subscription.metadata || {};
  const userId = metadata.app_user_id;
  return typeof userId === 'string' ? userId.trim() : '';
}

export async function findCustomerIdByEmail(client: DodoPayments, email: string) {
  const target = normalizeEmail(email);
  if (!target) return '';

  const first = await client.customers.list({ email: target, page_number: 1, page_size: 50 });
  const pages = [first];

  while (pages[pages.length - 1].hasNextPage() && pages.length < 10) {
    pages.push(await pages[pages.length - 1].getNextPage());
  }

  for (const page of pages) {
    const matched = page.items.find((item) => normalizeEmail(item.email) === target);
    if (matched?.customer_id) {
      return matched.customer_id;
    }
  }

  return '';
}

export async function findActiveSubscriptionForUser(client: DodoPayments, appUserId: string, email: string) {
  const normalizedEmail = normalizeEmail(email);

  const customerId = await findCustomerIdByEmail(client, normalizedEmail);
  if (customerId) {
    for (const status of ACTIVE_STATUSES) {
      const page = await client.subscriptions.list({
        customer_id: customerId,
        status,
        page_number: 1,
        page_size: 20,
      });
      const hit = page.items[0];
      if (hit?.subscription_id) {
        return hit as BasicSubscription;
      }
    }
  }

  for (const status of ACTIVE_STATUSES) {
    const first = await client.subscriptions.list({ status, page_number: 1, page_size: 50 });
    const pages = [first];

    while (pages[pages.length - 1].hasNextPage() && pages.length < 6) {
      pages.push(await pages[pages.length - 1].getNextPage());
    }

    for (const page of pages) {
      const hit = page.items.find((sub) => {
        const subEmail = normalizeEmail(sub.customer?.email);
        if (subEmail && normalizedEmail && subEmail === normalizedEmail) return true;
        if (appUserId && metadataUserId(sub as BasicSubscription) === appUserId) return true;
        return false;
      });

      if (hit?.subscription_id) {
        return hit as BasicSubscription;
      }
    }
  }

  return null;
}
