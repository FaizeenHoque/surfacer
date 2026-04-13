import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  createAuthedSupabase,
  createExtractionTemplate,
  deleteExtractionTemplate,
  getUserFromToken,
  listExtractionTemplates,
} from '$lib/server/chats';

export const GET: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);
    const templates = await listExtractionTemplates(supabase, user.id);

    return json({ templates });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected template list error';
    return json({ error: message }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const payload = await request.json();
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    const fieldsCsv = typeof payload.fieldsCsv === 'string' ? payload.fieldsCsv.trim() : '';

    if (name.length < 2) {
      return json({ error: 'Template name must be at least 2 characters.' }, { status: 400 });
    }

    const values = fieldsCsv
      .split(',')
      .map((item: string) => item.trim())
      .filter((item: string) => item.length > 0);

    if (!values.length) {
      return json({ error: 'Provide at least one extraction value separated by commas.' }, { status: 400 });
    }

    const normalizedFieldsCsv = values.join(', ');

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);
    const template = await createExtractionTemplate(supabase, {
      userId: user.id,
      name,
      fieldsCsv: normalizedFieldsCsv,
    });

    return json({ template }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected template create error';
    return json({ error: message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request, url }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const templateId = (url.searchParams.get('id') || '').trim();
    if (!templateId) {
      return json({ error: 'Template id is required.' }, { status: 400 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    await deleteExtractionTemplate(supabase, {
      userId: user.id,
      templateId,
    });

    return json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected template delete error';
    return json({ error: message }, { status: 500 });
  }
};
