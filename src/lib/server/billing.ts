import { env } from '$env/dynamic/private';

type CreditPack = {
  id: string;
  credits: number;
  productId: string;
  priceCents?: number;
  currency?: string;
  label?: string;
  interval?: 'month' | 'year' | 'one_time';
};

export type PublicCreditPack = {
  id: string;
  credits: number;
  priceCents: number | null;
  currency: string | null;
  label: string;
  interval: 'month' | 'year' | 'one_time';
};

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function normalizeInterval(value: unknown): 'month' | 'year' | 'one_time' {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'month' || raw === 'monthly') return 'month';
  if (raw === 'year' || raw === 'yearly' || raw === 'annual') return 'year';
  return 'one_time';
}

export function getDodoEnvironment(): 'test_mode' | 'live_mode' {
  const raw = (env.DODO_PAYMENTS_ENVIRONMENT || '').trim().toLowerCase();
  if (raw === 'test_mode' || raw === 'test') return 'test_mode';
  return 'live_mode';
}

export function getCreditPacks() {
  const configuredJson = env.DODO_CREDIT_PACKS_JSON;
  if (configuredJson) {
    try {
      const parsed = JSON.parse(configuredJson) as Array<Partial<CreditPack>>;
      const normalized = parsed
        .map((entry, index) => ({
          id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `pack_${index + 1}`,
          credits: toPositiveInt(entry.credits ?? (entry as { creditAmount?: unknown }).creditAmount, 0),
          productId:
            typeof entry.productId === 'string'
              ? entry.productId.trim()
              : typeof (entry as { product_id?: unknown }).product_id === 'string'
                ? String((entry as { product_id?: unknown }).product_id).trim()
                : '',
          priceCents: toPositiveInt((entry as { priceCents?: unknown; price_cents?: unknown }).priceCents ?? (entry as { priceCents?: unknown; price_cents?: unknown }).price_cents, 0),
          currency:
            typeof (entry as { currency?: unknown }).currency === 'string' &&
            String((entry as { currency?: unknown }).currency).trim()
              ? String((entry as { currency?: unknown }).currency).trim().toUpperCase()
              : undefined,
          label:
            typeof (entry as { label?: unknown; name?: unknown }).label === 'string'
              ? String((entry as { label?: unknown; name?: unknown }).label).trim()
              : typeof (entry as { label?: unknown; name?: unknown }).name === 'string'
                ? String((entry as { label?: unknown; name?: unknown }).name).trim()
                : undefined,
          interval: normalizeInterval((entry as { interval?: unknown; cadence?: unknown; billing_interval?: unknown }).interval ?? (entry as { interval?: unknown; cadence?: unknown; billing_interval?: unknown }).cadence ?? (entry as { interval?: unknown; cadence?: unknown; billing_interval?: unknown }).billing_interval),
        }))
        .filter((entry) => entry.credits > 0 && Boolean(entry.productId));

      if (normalized.length) {
        return normalized;
      }
    } catch {
      // Invalid JSON falls back to single-pack mode below.
    }
  }

  const productId = (env.DODO_CREDITS_PRODUCT_ID || env.DODO_PRODUCT_ID || '').trim();
  const credits = toPositiveInt(env.DODO_CREDITS_PACK_CREDITS || env.DODO_CREDITS_PER_PACK || 100, 100);
  const priceCents = toPositiveInt(env.DODO_CREDITS_PACK_PRICE_CENTS, 0);
  const currencyRaw = (env.DODO_CREDITS_PACK_CURRENCY || '').trim().toUpperCase();
  const label = (env.DODO_CREDITS_PACK_LABEL || '').trim();
  const interval = normalizeInterval(env.DODO_CREDITS_PACK_INTERVAL || env.DODO_CREDITS_INTERVAL || 'month');

  if (!productId) {
    return [];
  }

  return [
    {
      id: 'default',
      credits,
      productId,
      priceCents: priceCents > 0 ? priceCents : undefined,
      currency: currencyRaw || undefined,
      label: label || undefined,
      interval,
    },
  ];
}

export function getPublicCreditPacks(): PublicCreditPack[] {
  return getCreditPacks().map((pack) => ({
    id: pack.id,
    credits: pack.credits,
    priceCents: typeof pack.priceCents === 'number' && pack.priceCents > 0 ? pack.priceCents : null,
    currency: pack.currency || null,
    label: pack.label || `${pack.credits} credits`,
    interval: pack.interval || 'one_time',
  }));
}

export function findCreditPack(packId: string | null | undefined) {
  const packs = getCreditPacks();
  if (!packs.length) return null;

  if (!packId) {
    return packs[0];
  }

  return packs.find((pack) => pack.id === packId) || null;
}

export function getCreditsForPackId(packId: string | null | undefined) {
  const pack = findCreditPack(packId);
  return pack ? pack.credits : 0;
}

export function getCreditsForProductId(productId: string | null | undefined) {
  if (!productId) return 0;
  const normalized = productId.trim();
  if (!normalized) return 0;
  const pack = getCreditPacks().find((entry) => entry.productId === normalized);
  return pack ? pack.credits : 0;
}
