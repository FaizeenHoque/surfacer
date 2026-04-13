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

export type UserSubscription = BasicSubscription;

type BasicPayment = {
  metadata?: Record<string, unknown>;
  customer?: {
    customer_id?: string;
    email?: string;
  };
};

const ACTIVE_STATUSES: Array<BasicSubscription['status']> = ['active', 'pending', 'on_hold'];

function isActiveLike(subscription: BasicSubscription) {
  return ACTIVE_STATUSES.includes(subscription.status);
}

export function isSubscriptionActiveLike(subscription: Pick<BasicSubscription, 'status'> | null | undefined) {
  if (!subscription) return false;
  return ACTIVE_STATUSES.includes(subscription.status as BasicSubscription['status']);
}

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

function metadataUserEmail(subscription: BasicSubscription) {
  const metadata = subscription.metadata || {};
  const email = metadata.app_user_email;
  return typeof email === 'string' ? normalizeEmail(email) : '';
}

function paymentMetadataUserId(payment: BasicPayment) {
  const metadata = payment.metadata || {};
  const userId = metadata.app_user_id;
  return typeof userId === 'string' ? userId.trim() : '';
}

function paymentMetadataUserEmail(payment: BasicPayment) {
  const metadata = payment.metadata || {};
  const email = metadata.app_user_email;
  return typeof email === 'string' ? normalizeEmail(email) : '';
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

export async function findCustomerIdByUserIdentity(client: DodoPayments, appUserId: string, email: string) {
  const normalizedEmail = normalizeEmail(email);

  const byEmail = await findCustomerIdByEmail(client, normalizedEmail);
  if (byEmail) return byEmail;

  const first = await client.payments.list({ page_number: 1, page_size: 50 });
  const pages = [first];

  while (pages[pages.length - 1].hasNextPage() && pages.length < 20) {
    pages.push(await pages[pages.length - 1].getNextPage());
  }

  for (const page of pages) {
    const hit = (page.items as unknown as BasicPayment[]).find((payment) => {
      const byId = appUserId && paymentMetadataUserId(payment) === appUserId;
      if (byId) return true;

      const byMetaEmail = normalizedEmail && paymentMetadataUserEmail(payment) === normalizedEmail;
      if (byMetaEmail) return true;

      const byCustomerEmail = normalizedEmail && normalizeEmail(payment.customer?.email) === normalizedEmail;
      return byCustomerEmail;
    });

    if (hit?.customer?.customer_id) {
      return hit.customer.customer_id;
    }
  }

  return '';
}

export async function findActiveSubscriptionForUser(client: DodoPayments, appUserId: string, email: string) {
  const normalizedEmail = normalizeEmail(email);

  const customerId = await findCustomerIdByUserIdentity(client, appUserId, normalizedEmail);
  if (customerId) {
    const first = await client.subscriptions.list({
      customer_id: customerId,
      page_number: 1,
      page_size: 50,
    });
    const pages = [first];

    while (pages[pages.length - 1].hasNextPage() && pages.length < 10) {
      pages.push(await pages[pages.length - 1].getNextPage());
    }

    for (const page of pages) {
      const hit = page.items.find((sub) => isActiveLike(sub as BasicSubscription));
      if (hit?.subscription_id) {
        return hit as BasicSubscription;
      }
    }
  }

  const first = await client.subscriptions.list({ page_number: 1, page_size: 50 });
  const pages = [first];

  while (pages[pages.length - 1].hasNextPage() && pages.length < 20) {
    pages.push(await pages[pages.length - 1].getNextPage());
  }

  for (const page of pages) {
    const hit = page.items.find((sub) => {
      const subData = sub as BasicSubscription;
      if (!isActiveLike(subData)) return false;

      const byCustomerId = customerId && subData.customer?.customer_id === customerId;
      if (byCustomerId) return true;

      const subEmail = normalizeEmail(subData.customer?.email);
      if (subEmail && normalizedEmail && subEmail === normalizedEmail) return true;

      if (appUserId && metadataUserId(subData) === appUserId) return true;

      const metaEmail = metadataUserEmail(subData);
      if (normalizedEmail && metaEmail === normalizedEmail) return true;

      return false;
    });

    if (hit?.subscription_id) {
      return hit as BasicSubscription;
    }
  }

  return null;
}

export async function getSubscriptionById(client: DodoPayments, subscriptionId: string) {
  const id = subscriptionId.trim();
  if (!id) return null;

  try {
    const subscription = await client.subscriptions.retrieve(id);
    return subscription as BasicSubscription;
  } catch {
    return null;
  }
}
