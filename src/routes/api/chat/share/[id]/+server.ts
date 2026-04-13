import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { getSharedChatById } from '$lib/server/chats';

export const GET: RequestHandler = async ({ params }) => {
  try {
    const id = (params.id || '').trim();
    if (!id) {
      return json({ error: 'Share id is required.' }, { status: 400 });
    }

    const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    const shared = await getSharedChatById(supabase, id);

    if (!shared) {
      return json({ error: 'Shared chat not found.' }, { status: 404 });
    }

    return json({
      id: shared.id,
      fileName: shared.file_name,
      createdAt: shared.created_at,
      payload: shared.payload,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected share fetch error';
    return json({ error: message }, { status: 500 });
  }
};
