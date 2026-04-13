import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabaseUrl = PUBLIC_SUPABASE_URL;
    const publishableKey = PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (!supabaseUrl || !publishableKey) {
      return json({ error: 'Server auth configuration missing' }, { status: 500 });
    }

    const authClient = createClient(supabaseUrl, publishableKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser(token);

    if (authError || !user) {
      return json({ error: 'Invalid auth token' }, { status: 401 });
    }

    const existingProfile = await authClient
      .from('profiles')
      .select('credits')
      .eq('id', user.id)
      .maybeSingle();

    if (existingProfile.error) {
      return json({ error: existingProfile.error.message }, { status: 500 });
    }

    if (!existingProfile.data) {
      const insertResult = await authClient.from('profiles').insert({
        id: user.id,
        email: (user.email || '').toLowerCase(),
        credits: 35,
      });

      if (insertResult.error) {
        return json({ error: insertResult.error.message }, { status: 500 });
      }

      return json({ credits: 35, isNewUser: true });
    }

    const credits = typeof existingProfile.data.credits === 'number' ? existingProfile.data.credits : 0;
    return json({ credits, isNewUser: false });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    return json({ error: message }, { status: 500 });
  }
};
