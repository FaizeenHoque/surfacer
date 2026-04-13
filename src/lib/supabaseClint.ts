import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';

export const supabase = createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY);

console.log('Supabase env loaded:', {
	url: PUBLIC_SUPABASE_URL,
	hasKey: Boolean(PUBLIC_SUPABASE_PUBLISHABLE_KEY)
});
