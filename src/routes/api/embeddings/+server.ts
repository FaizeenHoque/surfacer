import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { createAuthedSupabase, getUserFromToken } from '$lib/server/chats';

const EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

type EmbeddingInputItem =
  | string
  | {
      content:
        | string
        | Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; image_url: { url: string } }
          >;
    };

export const POST: RequestHandler = async ({ request }) => {
  try {
    const authHeader = request.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!token) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    const supabase = createAuthedSupabase(token);
    await getUserFromToken(supabase, token);

    const payload = (await request.json()) as {
      input?: EmbeddingInputItem[];
      encoding_format?: 'float' | 'base64';
    };

    const input = Array.isArray(payload.input) ? payload.input : [];
    if (!input.length) {
      return json({ error: 'Input is required' }, { status: 400 });
    }

    const apiKey = env.OPENROUTER_API_KEY || '';
    if (!apiKey) {
      return json({ error: 'Missing OPENROUTER_API_KEY' }, { status: 500 });
    }

    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': env.OPENROUTER_SITE_URL || env.SITE_URL || 'http://localhost:5173',
        'X-OpenRouter-Title': env.OPENROUTER_SITE_NAME || 'Surfacer',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input,
        encoding_format: payload.encoding_format || 'float',
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const message =
        (typeof data === 'object' && data && 'error' in data && (data as { error?: { message?: string } }).error?.message) ||
        'Embedding request failed';
      return json({ error: message }, { status: response.status });
    }

    return json({
      model: EMBEDDING_MODEL,
      data,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected embedding error';
    return json({ error: message }, { status: 500 });
  }
};
