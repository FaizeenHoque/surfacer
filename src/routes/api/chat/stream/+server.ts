import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { OpenRouter } from '@openrouter/sdk';
import { PDFParse } from 'pdf-parse';
import { env } from '$env/dynamic/private';
import {
  appendChatMessage,
  createAuthedSupabase,
  fileNameFromPath,
  getOrCreateChatSession,
  getUserFromToken,
  listChatMessages,
} from '$lib/server/chats';

async function extractText(fileName: string, bytes: ArrayBuffer): Promise<string> {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const textExtensions = new Set(['txt', 'md', 'csv', 'json', 'log', 'xml', 'html']);

  if (ext === 'pdf') {
    const parser = new PDFParse({ data: Buffer.from(bytes) });
    try {
      const parsed = await parser.getText();
      return parsed.text || 'No readable text could be extracted from this PDF.';
    } finally {
      await parser.destroy();
    }
  }

  if (!textExtensions.has(ext)) {
    return 'The uploaded file is binary or unsupported for direct parsing. Ask questions based on metadata or upload a text-based file.';
  }

  return new TextDecoder().decode(bytes);
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    const user = await getUserFromToken(supabase, token);

    const payload = await request.json();
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : '';
    const model = 'minimax/minimax-m2.5:free';

    if (!message) {
      return json({ error: 'Message is required' }, { status: 400 });
    }

    if (!filePath || !filePath.startsWith(`${user.id}/`)) {
      return json({ error: 'Invalid file path' }, { status: 403 });
    }

    const bucket = env.SUPABASE_STORAGE_BUCKET || 'documents';
    const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(filePath);

    if (downloadError || !blob) {
      return json({ error: downloadError?.message || 'File not found' }, { status: 404 });
    }

    const fileBytes = await blob.arrayBuffer();
    const fileName = fileNameFromPath(filePath);
    const fileText = await extractText(fileName, fileBytes);
    const session = await getOrCreateChatSession(supabase, user.id, filePath, fileName);
    const priorMessages = await listChatMessages(supabase, session.id);

    await appendChatMessage(supabase, session.id, user.id, 'user', message);

    const apiKey = env.OPENROUTER_API_KEY || '';
    if (!apiKey) {
      return json({ error: 'Missing OPENROUTER_API_KEY' }, { status: 500 });
    }

    const openRouter = new OpenRouter({
      apiKey,
      httpReferer: env.OPENROUTER_SITE_URL || env.SITE_URL || 'http://localhost:5173',
      appTitle: env.OPENROUTER_SITE_NAME || 'Surfacer',
    });

    const stream = await openRouter.chat.send({
      chatRequest: {
        model,
        stream: true,
        maxCompletionTokens: 1024,
        messages: [
          {
            role: 'system',
            content:
              'You are Surfacer, a file analysis assistant. Answer only from the provided file context and the chat history. Format your response in clean Markdown with short headings, bullet lists, numbered steps when helpful, and Markdown tables when comparing facts. Use LaTeX math blocks for equations. Do not output raw JSON. If data is missing, say so clearly.',
          },
          {
            role: 'user',
            content: `File name: ${fileName}\n\nFile content:\n${fileText}`,
          },
          ...priorMessages.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
          {
            role: 'user',
            content: `Question: ${message}`,
          },
        ],
      },
    });

    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            let assistantResponse = '';
            for await (const event of stream) {
              const delta = event?.choices?.[0]?.delta?.content || '';
              if (delta) {
                assistantResponse += delta;
                controller.enqueue(encoder.encode(delta));
              }
            }
            if (assistantResponse.trim()) {
              await appendChatMessage(supabase, session.id, user.id, 'assistant', assistantResponse.trim());
            }
            controller.close();
          } catch (streamErr: unknown) {
            const streamMessage = streamErr instanceof Error ? streamErr.message : 'Streaming failed';
            controller.error(new Error(streamMessage));
          }
        },
      }),
      {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected chat error';
    return json({ error: message }, { status: 500 });
  }
};
