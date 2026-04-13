import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createAuthedSupabase, getUserFromToken, listExtractionRuns } from '$lib/server/chats';

export const GET: RequestHandler = async ({ request, url }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    const query = url.searchParams.get('query') || '';
    const days = Number(url.searchParams.get('days') || '30');

    const extractions = await listExtractionRuns(supabase, {
      userId: user.id,
      searchQuery: query,
      days: Number.isFinite(days) ? days : 30,
      limit: 120,
    });

    return json({
      extractions,
      windowDays: 30,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected extraction history error';
    return json({ error: message }, { status: 500 });
  }
};
