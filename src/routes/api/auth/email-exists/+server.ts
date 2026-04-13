import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { email } = await request.json();

    if (typeof email !== 'string' || !email.trim()) {
      return json({ error: 'Email is required' }, { status: 400 });
    }

    const supabaseUrl = env.PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
    const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Server auth configuration missing' }, { status: 500 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data, error } = await admin
      .schema('auth')
      .from('users')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();

    if (error) {
      return json({ error: error.message }, { status: 500 });
    }

    return json({ exists: Boolean(data) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected server error';
    return json({ error: message }, { status: 500 });
  }
};
