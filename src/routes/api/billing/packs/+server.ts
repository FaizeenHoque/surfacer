import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPublicCreditPacks } from '$lib/server/billing';

export const GET: RequestHandler = async () => {
  const packs = getPublicCreditPacks();
  return json({ packs });
};
