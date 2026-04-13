import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
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

const ALLOWED_MODELS = new Set([
  'minimax/minimax-m2.5:free',
  'google/gemini-2.0-flash-exp:free',
  'google/gemini-2.5-flash',
  'meta-llama/llama-3.3-70b-instruct:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
]);
const FILE_TEXT_CACHE = new Map<string, { text: string; updatedAt: number }>();
const FILE_EMBEDDINGS_CACHE = new Map<string, { chunks: string[]; vectors: number[][]; updatedAt: number }>();
const MAX_CACHE_ENTRIES = 20;
const MAX_CONTEXT_MESSAGES = 16;
const EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const EMBEDDING_API_URL = 'https://openrouter.ai/api/v1/embeddings';
const CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

type EmbeddingApiResponse = {
  data?: Array<{ embedding?: number[] }>;
};

type ChatDeltaEvent = {
  choices?: Array<{
    delta?: {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      reasoningContent?: unknown;
    };
  }>;
};

function getCachedFileText(filePath: string) {
  return FILE_TEXT_CACHE.get(filePath)?.text || null;
}

function setCachedFileText(filePath: string, text: string) {
  FILE_TEXT_CACHE.set(filePath, { text, updatedAt: Date.now() });
  if (FILE_TEXT_CACHE.size <= MAX_CACHE_ENTRIES) return;

  const entries = [...FILE_TEXT_CACHE.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const [oldest] = entries;
  if (oldest) FILE_TEXT_CACHE.delete(oldest[0]);
}

function setCachedFileEmbeddings(filePath: string, chunks: string[], vectors: number[][]) {
  FILE_EMBEDDINGS_CACHE.set(filePath, { chunks, vectors, updatedAt: Date.now() });
  if (FILE_EMBEDDINGS_CACHE.size <= MAX_CACHE_ENTRIES) return;

  const entries = [...FILE_EMBEDDINGS_CACHE.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const [oldest] = entries;
  if (oldest) FILE_EMBEDDINGS_CACHE.delete(oldest[0]);
}

function chunkText(fileText: string, chunkSize = 1200) {
  const chunks: string[] = [];
  for (let index = 0; index < fileText.length; index += chunkSize) {
    chunks.push(fileText.slice(index, index + chunkSize));
  }
  return chunks;
}

function cosineSimilarity(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const av = a[index];
    const bv = b[index];
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function embedInputs(
  apiKey: string,
  inputs: string[],
  referer: string,
  title: string
): Promise<number[][]> {
  const response = await fetch(EMBEDDING_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': referer,
      'X-OpenRouter-Title': title,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
      encoding_format: 'float',
    }),
  });

  const data = (await response.json()) as EmbeddingApiResponse & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(data.error?.message || 'Embedding request failed');
  }

  return (data.data || []).map((entry) => (Array.isArray(entry.embedding) ? entry.embedding : []));
}

async function buildPromptContext(
  filePath: string,
  fileText: string,
  question: string,
  apiKey: string,
  referer: string,
  title: string,
  maxContextChars: number
) {
  if (fileText.length <= maxContextChars) {
    return fileText;
  }

  const cached = FILE_EMBEDDINGS_CACHE.get(filePath);
  const chunks = cached?.chunks || chunkText(fileText, 1200).slice(0, 80);
  let vectors = cached?.vectors || [];

  if (!vectors.length) {
    const nextVectors: number[][] = [];
    const batchSize = 16;

    for (let index = 0; index < chunks.length; index += batchSize) {
      const batch = chunks.slice(index, index + batchSize);
      const embedded = await embedInputs(apiKey, batch, referer, title);
      nextVectors.push(...embedded);
    }

    vectors = nextVectors;
    setCachedFileEmbeddings(filePath, chunks, vectors);
  }

  const [questionVector] = await embedInputs(apiKey, [question], referer, title);

  const ranked = chunks
    .map((chunk, index) => ({
      text: chunk,
      index,
      score: cosineSimilarity(questionVector || [], vectors[index] || []),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 10)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.text);

  const context = [chunks[0] || '', ...ranked].join('\n\n');

  return context.slice(0, maxContextChars);
}

async function* streamChatCompletions(
  apiKey: string,
  referer: string,
  appTitle: string,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
) {
  const body: {
    model: string;
    stream: boolean;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    max_tokens?: number;
  } = {
    model,
    stream: true,
    messages,
  };

  // Llama free providers are often strict about optional generation params.
  if (model !== 'meta-llama/llama-3.3-70b-instruct:free') {
    body.max_tokens = 1024;
  }

  const response = await fetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': referer,
      'X-OpenRouter-Title': appTitle,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = (await response.json().catch(() => ({}))) as { error?: { message?: string }; message?: string };
    throw new Error(err.error?.message || err.message || 'Provider returned error');
  }

  if (!response.body) {
    throw new Error('No stream received from provider');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          return;
        }

        try {
          yield JSON.parse(payload) as ChatDeltaEvent;
        } catch {
          // Ignore non-JSON keepalive fragments.
        }
      }

      newlineIndex = buffer.indexOf('\n');
    }
  }
}

function normalizeDeltaText(value: unknown) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';

  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'text' in entry) {
        return String((entry as { text: unknown }).text ?? '');
      }
      return '';
    })
    .join('');
}

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
    const requestedModel = typeof payload.model === 'string' ? payload.model : '';
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : 'minimax/minimax-m2.5:free';

    if (!message) {
      return json({ error: 'Message is required' }, { status: 400 });
    }

    if (!filePath || !filePath.startsWith(`${user.id}/`)) {
      return json({ error: 'Invalid file path' }, { status: 403 });
    }

    const fileName = fileNameFromPath(filePath);
    let fileText = getCachedFileText(filePath);

    if (!fileText) {
      const bucket = env.SUPABASE_STORAGE_BUCKET || 'documents';
      const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(filePath);

      if (downloadError || !blob) {
        return json({ error: downloadError?.message || 'File not found' }, { status: 404 });
      }

      const fileBytes = await blob.arrayBuffer();
      fileText = await extractText(fileName, fileBytes);
      setCachedFileText(filePath, fileText);
    }

    const apiKey = env.OPENROUTER_API_KEY || '';
    if (!apiKey) {
      return json({ error: 'Missing OPENROUTER_API_KEY' }, { status: 500 });
    }

    const referer = env.OPENROUTER_SITE_URL || env.SITE_URL || 'http://localhost:5173';
    const appTitle = env.OPENROUTER_SITE_NAME || 'Surfacer';
    const maxContextChars = model === 'meta-llama/llama-3.3-70b-instruct:free' ? 16000 : 28000;
    const promptContext = await buildPromptContext(filePath, fileText, message, apiKey, referer, appTitle, maxContextChars);
    const session = await getOrCreateChatSession(supabase, user.id, filePath, fileName);
    const priorMessages = (await listChatMessages(supabase, session.id)).slice(-MAX_CONTEXT_MESSAGES);

    await appendChatMessage(supabase, session.id, user.id, 'user', message);

    const chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are Surfacer, a file analysis assistant. Answer only from the provided file context and the chat history. Format your response in clean Markdown with short headings, bullet lists, numbered steps when helpful, and Markdown tables when comparing facts. Use LaTeX math blocks for equations. Do not output raw JSON. If data is missing, say so clearly.',
      },
      {
        role: 'user',
        content: `File name: ${fileName}\n\nRelevant file excerpts:\n${promptContext}`,
      },
      ...priorMessages.map((entry) => ({
        role: entry.role,
        content: entry.content,
      })),
      {
        role: 'user',
        content: `Question: ${message}`,
      },
    ];

    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream({
        async start(controller) {
          try {
            let assistantResponse = '';

            const sendEvent = (type: 'content' | 'reasoning' | 'done', delta = '') => {
              controller.enqueue(encoder.encode(`${JSON.stringify({ type, delta })}\n`));
            };

            for await (const event of streamChatCompletions(apiKey, referer, appTitle, model, chatMessages)) {
              const deltaNode = event?.choices?.[0]?.delta;

              const contentDelta = normalizeDeltaText(deltaNode?.content);
              const reasoningDelta =
                normalizeDeltaText(deltaNode?.reasoning) ||
                normalizeDeltaText(deltaNode?.reasoning_content) ||
                normalizeDeltaText(deltaNode?.reasoningContent);

              if (reasoningDelta) {
                sendEvent('reasoning', reasoningDelta);
              }

              if (contentDelta) {
                assistantResponse += contentDelta;
                sendEvent('content', contentDelta);
              }
            }

            sendEvent('done');

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
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
        },
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected chat error';
    return json({ error: message }, { status: 500 });
  }
};
