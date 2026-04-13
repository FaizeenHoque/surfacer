import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';

export const GET: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return json({ error: 'Invalid auth token' }, { status: 401 });
    }

    const bucket = env.SUPABASE_STORAGE_BUCKET || 'documents';
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(user.id, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

    if (error) {
      return json({ error: error.message }, { status: 500 });
    }

    const files = (data || [])
      .filter((item) => item.name)
      .map((item) => ({
        path: `${user.id}/${item.name}`,
        name: item.name,
        size: item.metadata?.size || 0,
      }));

    return json({ files });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected list error';
    return json({ error: message }, { status: 500 });
  }
};
