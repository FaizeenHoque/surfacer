import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
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

    const payload = await request.json();
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : '';

    if (!filePath || !filePath.startsWith(`${user.id}/`)) {
      return json({ error: 'Invalid file path' }, { status: 403 });
    }

    const bucket = env.SUPABASE_STORAGE_BUCKET || 'documents';
    const { error } = await supabase.storage.from(bucket).remove([filePath]);

    if (error) {
      return json({ error: error.message }, { status: 500 });
    }

    const { error: extractionDeleteError } = await supabase
      .from('extraction_runs')
      .delete()
      .eq('user_id', user.id)
      .eq('file_path', filePath);

    if (extractionDeleteError) {
      return json({ error: extractionDeleteError.message }, { status: 500 });
    }

    return json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected delete error';
    return json({ error: message }, { status: 500 });
  }
};
