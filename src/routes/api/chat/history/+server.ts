import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  createAuthedSupabase,
  fileNameFromPath,
  getOrCreateChatSession,
  getUserFromToken,
  listChatMessages,
} from '$lib/server/chats';

export const GET: RequestHandler = async ({ request, url }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const filePath = url.searchParams.get('filePath') || '';
    if (!filePath) {
      return json({ error: 'File path is required' }, { status: 400 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    if (!filePath.startsWith(`${user.id}/`)) {
      return json({ error: 'Invalid file path' }, { status: 403 });
    }

    const session = await getOrCreateChatSession(supabase, user.id, filePath, fileNameFromPath(filePath));
    const messages = await listChatMessages(supabase, session.id);

    return json({
      chatId: session.id,
      filePath: session.file_path,
      fileName: session.file_name,
      messages,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected chat history error';
    return json({ error: message }, { status: 500 });
  }
};
