import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createAuthedSupabase, createSharedChat, getUserFromToken } from '$lib/server/chats';

type ShareMessage = {
  id: string;
  type: 'system' | 'user' | 'ai';
  text?: string;
  content?: string;
  reasoning?: string;
  timestamp?: string;
};

export const POST: RequestHandler = async ({ request, url }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    const payload = await request.json();
    const chatId = typeof payload.chatId === 'string' ? payload.chatId : null;
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : null;
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : null;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    const sanitizedMessages = messages
      .map((entry: ShareMessage) => {
        const type = entry.type;
        if (type !== 'system' && type !== 'user' && type !== 'ai') return null;

        return {
          id: typeof entry.id === 'string' ? entry.id : '',
          type,
          text: typeof entry.text === 'string' ? entry.text : undefined,
          content: typeof entry.content === 'string' ? entry.content : undefined,
          reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : undefined,
          timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
        };
      })
      .filter((entry: ShareMessage | null): entry is ShareMessage => Boolean(entry));

    if (!sanitizedMessages.length) {
      return json({ error: 'No messages available to share.' }, { status: 400 });
    }

    const shared = await createSharedChat(supabase, {
      userId: user.id,
      chatId,
      filePath,
      fileName,
      payload: {
        fileName,
        sharedAt: new Date().toISOString(),
        messages: sanitizedMessages,
      },
    });

    const shareUrl = `${url.origin}/share/${shared.id}`;

    return json({
      id: shared.id,
      shareUrl,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected share create error';
    return json({ error: message }, { status: 500 });
  }
};
