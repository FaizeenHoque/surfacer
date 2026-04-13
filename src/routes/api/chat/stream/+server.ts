import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { PDFParse } from 'pdf-parse';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { env } from '$env/dynamic/private';
import {
  appendChatMessage,
  createAuthedSupabase,
  fileNameFromPath,
  getUserCredits,
  getOrCreateChatSession,
  getUserFromToken,
  listChatMessages,
  saveExtractionRun,
  setUserCredits,
} from '$lib/server/chats';

const ALLOWED_MODELS = new Set([
  'microsoft/Phi-4',
  'deepseek/DeepSeek-V3-0324',
]);
const FILE_TEXT_CACHE = new Map<string, { text: string; pageCount: number; updatedAt: number }>();
const MAX_CACHE_ENTRIES = 20;
const MAX_CONTEXT_MESSAGES = 16;

const CHAT_COMPLETIONS_URL = 'https://models.github.ai/inference/chat/completions';
const BASIC_MODEL = 'microsoft/Phi-4';
const PREMIUM_MODEL = 'deepseek/DeepSeek-V3-0324';
const DEBUG_CHAT = (env.DEBUG_CHAT || '').toLowerCase() === '1' || (env.DEBUG_CHAT || '').toLowerCase() === 'true';
const MAX_CONCURRENT_CHAT_REQUESTS = 1;
const CHAT_BURST_WINDOW_MS = 15_000;
const CHAT_BURST_LIMIT = 3;
const BASIC_MODEL_MULTIPLIER = 1;
const PREMIUM_MODEL_MULTIPLIER = 10;
const CREDIT_BASE_COST = 2;
const CREDIT_PAGE_COST = 0.2;
const FOLLOW_UP_CREDIT_COST = 1;
const DEFAULT_CHARS_PER_PAGE = 3000;

type ExtractedDocument = {
  text: string;
  pageCount: number;
};

function estimatePageCountFromText(fileText: string) {
  return Math.max(1, Math.ceil(fileText.length / DEFAULT_CHARS_PER_PAGE));
}

function estimatePageCountFromBytes(byteLength: number) {
  return Math.max(1, Math.ceil(byteLength / DEFAULT_CHARS_PER_PAGE));
}

function getModelMultiplier(model: string) {
  return model === PREMIUM_MODEL ? PREMIUM_MODEL_MULTIPLIER : BASIC_MODEL_MULTIPLIER;
}

function calculateCreditCost(pageCount: number, model: string) {
  const base = CREDIT_BASE_COST;
  const pageCost = CREDIT_PAGE_COST;
  const multiplier = getModelMultiplier(model);
  return Number((base + (pageCount * pageCost) * multiplier).toFixed(2));
}

type RateLimitState = {
  activeCount: number;
  recentStarts: number[];
};

type RateLimitLease = {
  release: () => void;
};

const CHAT_RATE_LIMITS = new Map<string, RateLimitState>();



type ChatCompletionApiResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

type ChatCompletionJsonResponse = ChatCompletionApiResponse & {
  error?: { message?: string };
  message?: string;
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

function parseJsonSafe<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function clipText(value: string, max = 500) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function debugLog(requestId: string, stage: string, payload?: Record<string, unknown>) {
  if (!DEBUG_CHAT) return;
  const prefix = `[chat:${requestId}] ${stage}`;
  if (payload) {
    console.info(prefix, payload);
    return;
  }
  console.info(prefix);
}

function acquireChatRateLimit(userId: string):
  | { allowed: true; lease: RateLimitLease }
  | { allowed: false; retryAfterSeconds: number; message: string } {
  const now = Date.now();
  const state = CHAT_RATE_LIMITS.get(userId) || { activeCount: 0, recentStarts: [] };
  state.recentStarts = state.recentStarts.filter((startedAt) => now - startedAt < CHAT_BURST_WINDOW_MS);

  if (state.activeCount >= MAX_CONCURRENT_CHAT_REQUESTS) {
    const retryAfterSeconds = 3;
    CHAT_RATE_LIMITS.set(userId, state);
    return {
      allowed: false,
      retryAfterSeconds,
      message: 'Please wait for the current response to finish before sending another message.',
    };
  }

  if (state.recentStarts.length >= CHAT_BURST_LIMIT) {
    const earliest = state.recentStarts[0] || now;
    const retryAfterSeconds = Math.max(1, Math.ceil((CHAT_BURST_WINDOW_MS - (now - earliest)) / 1000));
    CHAT_RATE_LIMITS.set(userId, state);
    return {
      allowed: false,
      retryAfterSeconds,
      message: 'You are sending messages too quickly. Please slow down and try again shortly.',
    };
  }

  state.activeCount += 1;
  state.recentStarts.push(now);
  CHAT_RATE_LIMITS.set(userId, state);

  let released = false;
  return {
    allowed: true,
    lease: {
      release() {
        if (released) return;
        released = true;

        const current = CHAT_RATE_LIMITS.get(userId);
        if (!current) return;

        const nowAtRelease = Date.now();
        current.activeCount = Math.max(0, current.activeCount - 1);
        current.recentStarts = current.recentStarts.filter((startedAt) => nowAtRelease - startedAt < CHAT_BURST_WINDOW_MS);

        if (current.activeCount <= 0 && current.recentStarts.length === 0) {
          CHAT_RATE_LIMITS.delete(userId);
          return;
        }

        CHAT_RATE_LIMITS.set(userId, current);
      },
    },
  };
}

function getCachedFileText(filePath: string) {
  return FILE_TEXT_CACHE.get(filePath) || null;
}

function setCachedFileText(filePath: string, text: string, pageCount: number) {
  FILE_TEXT_CACHE.set(filePath, { text, pageCount, updatedAt: Date.now() });
  if (FILE_TEXT_CACHE.size <= MAX_CACHE_ENTRIES) return;

  const entries = [...FILE_TEXT_CACHE.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const [oldest] = entries;
  if (oldest) FILE_TEXT_CACHE.delete(oldest[0]);
}









async function createChatCompletion(
  apiKey: string,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  requestId: string
) : Promise<AsyncGenerator<ChatDeltaEvent, void, unknown>> {
  const body: {
    model: string;
    stream: boolean;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    max_completion_tokens: number;
    reasoning?: { enabled: boolean };
  } = {
    model,
    stream: true,
    messages,
    max_completion_tokens: 1024,
  };

  if (model === PREMIUM_MODEL) {
    body.reasoning = { enabled: true };
  }

  const sendRequest = async (payload: typeof body) =>
    fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  debugLog(requestId, 'provider_request', {
    model,
    messageCount: messages.length,
    reasoningEnabled: Boolean(body.reasoning?.enabled),
  });

  let response = await sendRequest(body);

  if (!response.ok && model === PREMIUM_MODEL && body.reasoning) {
    const firstRaw = await response.text();
    debugLog(requestId, 'provider_retry_without_reasoning', {
      status: response.status,
      statusText: response.statusText,
      providerRequestId: response.headers.get('x-request-id') || 'n/a',
      bodyPreview: clipText(firstRaw),
    });

    const fallbackBody = { ...body };
    delete fallbackBody.reasoning;
    response = await sendRequest(fallbackBody);
  }

  if (!response.ok) {
    const raw = await response.text();
    const err = parseJsonSafe<{ error?: { message?: string }; message?: string }>(raw) || {};
    const providerRequestId = response.headers.get('x-request-id') || 'n/a';
    debugLog(requestId, 'provider_error', {
      status: response.status,
      statusText: response.statusText,
      providerRequestId,
      bodyPreview: clipText(raw),
    });
    const details = `status=${response.status} statusText=${response.statusText || 'unknown'} providerRequestId=${providerRequestId}`;
    throw new Error(
      `${err.error?.message || err.message || clipText(raw) || 'Provider returned error'} (${details})`
    );
  }

  if (!response.body) {
    throw new Error('No stream received from provider');
  }

  async function* parseStream() {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) break;

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line || line.startsWith(':') || line.startsWith('event:')) {
          continue;
        }

        if (!line.startsWith('data:')) {
          continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          continue;
        }

        const parsed = parseJsonSafe<ChatDeltaEvent>(payload);
        if (parsed) {
          yield parsed;
        }
      }
    }

    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        const parsed = parseJsonSafe<ChatDeltaEvent>(payload);
        if (parsed) {
          yield parsed;
        }
      }
    }
  }

  return parseStream();
}

async function generateFollowUpQuestions(
  apiKey: string,
  model: string,
  context: string,
  originalQuestion: string,
  assistantAnswer: string,
  requestId: string
) {
  const response = await fetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      stream: false,
      max_completion_tokens: 180,
      messages: [
        {
          role: 'system',
          content:
            'Generate exactly 3 short follow-up questions a user would naturally ask next. Use the document context, the user\'s question, and the answer. Return only a JSON array of 3 strings. Do not include numbering, bullets, markdown, code fences, or any extra text.',
        },
        {
          role: 'user',
          content:
            `Document context:\n${context}\n\nOriginal question:\n${originalQuestion}\n\nAnswer:\n${assistantAnswer}`,
        },
      ],
    }),
  });

  const raw = await response.text();
  const data = parseJsonSafe<ChatCompletionJsonResponse>(raw) || {};

  if (!response.ok) {
    throw new Error(data.error?.message || data.message || raw || 'Follow-up generation failed');
  }

  const content = data.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((entry) => (typeof entry === 'string' ? entry : '')).join('')
    : typeof content === 'string'
      ? content
      : '';

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const parsed = parseJsonSafe<unknown>(cleaned);

  if (!Array.isArray(parsed)) {
    debugLog(requestId, 'followup_parse_failed', { rawPreview: clipText(cleaned) });
    return [];
  }

  return parsed
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => Boolean(entry))
    .slice(0, 3);
}

async function finalizeAssistantResponse(options: {
  supabase: ReturnType<typeof createAuthedSupabase>;
  apiKey: string;
  sessionId: string;
  userId: string;
  filePath: string;
  fileName: string;
  assistantResponse: string;
  currentCredits: number;
  responseCost: number;
  responseModel: string;
  promptContext: string;
  originalQuestion: string;
  isFollowUp: boolean;
  requestId: string;
  sendEvent: (payload: Record<string, unknown>) => void;
}) {
  const {
    supabase,
    apiKey,
    sessionId,
    userId,
    filePath,
    fileName,
    assistantResponse,
    currentCredits,
    responseCost,
    responseModel,
    promptContext,
    originalQuestion,
    isFollowUp,
    requestId,
    sendEvent,
  } = options;

  const trimmedResponse = assistantResponse.trim();
  if (!trimmedResponse) return currentCredits;

  await appendChatMessage(supabase, sessionId, userId, 'assistant', trimmedResponse);
  await saveExtractionRun(supabase, {
    userId,
    chatId: sessionId,
    filePath,
    fileName,
    prompt: originalQuestion,
    result: trimmedResponse,
  });
  const creditsRemaining = await setUserCredits(supabase, userId, currentCredits - responseCost);

  sendEvent({
    type: 'usage',
    creditsUsed: responseCost,
    creditsRemaining,
  });

  if (!isFollowUp) {
    try {
      sendEvent({ type: 'followup_loading', loading: true });
      const followUps = await generateFollowUpQuestions(
        apiKey,
        responseModel,
        promptContext,
        originalQuestion,
        trimmedResponse,
        requestId
      );

      if (followUps.length) {
        sendEvent({
          type: 'followup_suggestions',
          suggestions: followUps,
        });
      }
    } catch (err: unknown) {
      debugLog(requestId, 'followup_generation_failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sendEvent({ type: 'followup_loading', loading: false });
    }
  }

  return creditsRemaining;
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

async function extractDocx(fileBytes: Buffer): Promise<ExtractedDocument> {
  const zip = await JSZip.loadAsync(fileBytes);
  const appXml = await zip.file('docProps/app.xml')?.async('text');
  const documentXml = await zip.file('word/document.xml')?.async('text');

  const metadataPages = Number(appXml?.match(/<Pages>(\d+)<\/Pages>/i)?.[1] || 0);
  const manualBreaks = (documentXml?.match(/<w:br\b[^>]*\bw:type=(['"])page\1[^>]*\/?>/g) || []).length;
  const renderedBreaks = (documentXml?.match(/<w:lastRenderedPageBreak\b[^>]*\/?>/g) || []).length;
  const inferredBreakPages = manualBreaks + renderedBreaks > 0 ? manualBreaks + renderedBreaks + 1 : 0;

  const text = (documentXml || '')
    .replace(/<w:p\b[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const estimatedPages = estimatePageCountFromText(text);
  const pageCount = Math.max(1, metadataPages || inferredBreakPages || estimatedPages);

  return {
    text: text || 'No readable text could be extracted from this DOCX.',
    pageCount,
  };
}

function extractXlsx(fileBytes: Buffer): ExtractedDocument {
  const workbook = XLSX.read(fileBytes, { type: 'buffer' });
  const sheetTexts: string[] = [];
  let totalRows = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
    });

    totalRows += rows.length;

    const csvText = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, forceQuotes: false }).trim();
    if (csvText) {
      sheetTexts.push(`# Sheet: ${sheetName}\n${csvText}`);
    }
  }

  const text = sheetTexts.join('\n\n').trim();
  const rowBasedPages = Math.max(1, Math.ceil(totalRows / 50));
  const textBasedPages = estimatePageCountFromText(text);

  return {
    text: text || 'No readable table data could be extracted from this XLSX.',
    pageCount: Math.max(rowBasedPages, textBasedPages),
  };
}

function extractCsv(bytes: ArrayBuffer): ExtractedDocument {
  const text = new TextDecoder().decode(bytes).trim();
  const rowCount = text ? text.split(/\r\n|\n|\r/).length : 0;
  const rowBasedPages = Math.max(1, Math.ceil(rowCount / 50));
  const textBasedPages = estimatePageCountFromText(text);

  return {
    text: text || 'No readable text could be extracted from this CSV.',
    pageCount: Math.max(rowBasedPages, textBasedPages),
  };
}

async function extractText(fileName: string, bytes: ArrayBuffer): Promise<ExtractedDocument> {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const textExtensions = new Set(['txt', 'md', 'csv', 'json', 'log', 'xml', 'html']);
  const fileBytes = Buffer.from(bytes);

  if (ext === 'pdf') {
    try {
      const parser = new PDFParse({ data: fileBytes });
      const result = await parser.getText();
      await parser.destroy();
      return {
        text: result.text?.trim() || 'No readable text could be extracted from this PDF.',
        pageCount: Math.max(1, result.total || estimatePageCountFromText(result.text || '')),
      };
    } catch (pdfErr) {
      const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      // Scanned/image-only or encrypted PDFs have no text layer — degrade gracefully
      if (
        msg.toLowerCase().includes('encrypt') ||
        msg.toLowerCase().includes('password') ||
        msg.toLowerCase().includes('bad xref') ||
        msg.toLowerCase().includes('invalid pdf')
      ) {
        return {
          text: 'This PDF could not be parsed. It may be scanned, image-only, encrypted, or corrupted.',
          pageCount: estimatePageCountFromBytes(fileBytes.byteLength),
        };
      }
      throw pdfErr;
    }
  }

  if (ext === 'docx') {
    return extractDocx(fileBytes);
  }

  if (ext === 'xlsx' || ext === 'xls') {
    return extractXlsx(fileBytes);
  }

  if (ext === 'csv') {
    return extractCsv(bytes);
  }

  if (!textExtensions.has(ext)) {
    return {
      text: 'The uploaded file is binary or unsupported for direct parsing. Ask questions based on metadata or upload a text-based file.',
      pageCount: estimatePageCountFromBytes(fileBytes.byteLength),
    };
  }

  const text = new TextDecoder().decode(bytes);
  return {
    text,
    pageCount: estimatePageCountFromText(text),
  };
}

export const POST: RequestHandler = async ({ request }) => {
  const requestId = Math.random().toString(36).slice(2, 10);
  let rateLimitLease: RateLimitLease | null = null;
  try {
    const authHeader = request.headers.get('authorization');
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';

    debugLog(requestId, 'auth_check', {
      hasAuthHeader: !!authHeader,
      authHeaderPrefix: authHeader?.slice(0, 10),
      tokenLength: headerToken.length,
      isTokenEmpty: headerToken === '',
    });

    if (!headerToken) {
      return json({ error: 'Missing auth token' }, { status: 401 });
    }

    // Parse body first before doing any async auth work
    const payload = await request.json();
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : '';
    const requestedModel = typeof payload.model === 'string' ? payload.model : '';
    const isFollowUp = payload.followUp === true;
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : BASIC_MODEL;

    // Now validate auth with Supabase
    const supabase = createAuthedSupabase(headerToken);
    let user;
    try {
      user = await getUserFromToken(supabase, headerToken);
    } catch (authErr: unknown) {
      const authMessage = authErr instanceof Error ? authErr.message : 'Authentication failed';
      debugLog(requestId, 'getUserFromToken_failed', {
        errorMsg: authMessage,
        tokenLength: headerToken.length,
      });
      return json({ error: authMessage }, { status: 401 });
    }

    debugLog(requestId, 'request_received', {
      userId: user.id,
      filePath,
      modelRequested: requestedModel,
      modelUsed: model,
      messageChars: message.length,
    });

    if (!message) {
      return json({ error: 'Message is required' }, { status: 400 });
    }

    const rateLimit = acquireChatRateLimit(user.id);
    if (!rateLimit.allowed) {
      return json(
        { error: rateLimit.message },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimit.retryAfterSeconds),
          },
        }
      );
    }

    rateLimitLease = rateLimit.lease;

    if (!filePath || !filePath.startsWith(`${user.id}/`)) {
      rateLimitLease.release();
      rateLimitLease = null;
      return json({ error: 'Invalid file path' }, { status: 403 });
    }

    const fileName = fileNameFromPath(filePath);
    let cachedFile = getCachedFileText(filePath);
    let fileText = cachedFile?.text || null;
    let pageCount = cachedFile?.pageCount || 0;

    if (!fileText) {
      const bucket = env.SUPABASE_STORAGE_BUCKET || 'documents';
      
      debugLog(requestId, 'storage_download_start', {
        filePath,
        bucket,
        tokenLength: headerToken.length,
      });

      const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(filePath);

      if (downloadError || !blob) {
        const errorMsg = downloadError?.message || 'File not found';
        debugLog(requestId, 'storage_download_failed', {
          filePath,
          errorMsg,
          errorStatus: downloadError?.status,
          downloadErrorDetails: JSON.stringify(downloadError),
        });
        rateLimitLease.release();
        rateLimitLease = null;
        return json({ error: errorMsg }, { status: downloadError?.status === 401 ? 401 : 404 });
      }

      try {
        const fileBytes = await blob.arrayBuffer();
        const extracted = await extractText(fileName, fileBytes);
        fileText = extracted.text;
        pageCount = extracted.pageCount;
        setCachedFileText(filePath, fileText, pageCount);
      } catch (extractErr) {
        const extractMessage = extractErr instanceof Error ? extractErr.message : 'Failed to extract file text';
        debugLog(requestId, 'file_extraction_failed', {
          filePath,
          errorMsg: extractMessage,
        });
        throw extractErr;
      }
    }

    if (pageCount <= 0) {
      pageCount = estimatePageCountFromText(fileText || '');
    }

    const estimatedCost = isFollowUp ? FOLLOW_UP_CREDIT_COST : calculateCreditCost(pageCount, model);
    const currentCredits = await getUserCredits(supabase, user.id);

    if (currentCredits < estimatedCost) {
      rateLimitLease.release();
      rateLimitLease = null;
      return json(
        {
          error: `Not enough credits. Required: ${estimatedCost}, available: ${currentCredits}.`,
        },
        { status: 402 }
      );
    }

    const apiKey = env.GITHUB_TOKEN || '';
    if (!apiKey) {
      rateLimitLease.release();
      rateLimitLease = null;
      return json({ error: 'Missing GITHUB_TOKEN' }, { status: 500 });
    }

    const maxContextChars = 28000;
    const promptContext = fileText.slice(0, maxContextChars);
    const session = await getOrCreateChatSession(supabase, user.id, filePath, fileName);
    const priorMessages = (await listChatMessages(supabase, session.id)).slice(-MAX_CONTEXT_MESSAGES);

    await appendChatMessage(supabase, session.id, user.id, 'user', message);

    const chatMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are Surfacer, a strict document-grounded assistant. Answer only using the provided file excerpts and chat history. If the user asks anything not supported by that context, reply exactly: "I cannot answer that from this document." Never use outside knowledge, never guess, and do not invent facts. Keep responses in clean Markdown with short headings, bullet points, and tables when useful. Use LaTeX for math. Do not output raw JSON.',
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

    let assistantResponse = '';
    let responseModel = model;

    try {
      const encoder = new TextEncoder();
      const stream = await createChatCompletion(apiKey, model, chatMessages, requestId);

      return new Response(
        new ReadableStream({
          async start(controller) {
            try {
              const sendEvent = (payload: Record<string, unknown>) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
              };

              controller.enqueue(encoder.encode(': stream-open\n\n'));

              for await (const event of stream) {
                const deltaNode = event?.choices?.[0]?.delta;
                const contentDelta = normalizeDeltaText(deltaNode?.content);
                const reasoningDelta =
                  normalizeDeltaText(deltaNode?.reasoning) ||
                  normalizeDeltaText(deltaNode?.reasoning_content) ||
                  normalizeDeltaText(deltaNode?.reasoningContent);

                if (reasoningDelta) {
                  sendEvent({ type: 'reasoning', delta: reasoningDelta });
                }

                if (contentDelta) {
                  assistantResponse += contentDelta;
                  sendEvent({ type: 'content', delta: contentDelta });
                }
              }

              if (assistantResponse.trim()) {
                const responseCost = isFollowUp ? FOLLOW_UP_CREDIT_COST : calculateCreditCost(pageCount, responseModel);
                await finalizeAssistantResponse({
                  supabase,
                  apiKey,
                  sessionId: session.id,
                  userId: user.id,
                  filePath,
                  fileName,
                  assistantResponse,
                  currentCredits,
                  responseCost,
                  responseModel,
                  promptContext,
                  originalQuestion: message,
                  isFollowUp,
                  requestId,
                  sendEvent,
                });
              }

              sendEvent({ type: 'done' });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));

              debugLog(requestId, 'response_saved', { sessionId: session.id, responseModel });
              controller.close();
            } catch (streamErr: unknown) {
              const streamMessage = streamErr instanceof Error ? streamErr.message : 'Streaming failed';
              controller.error(new Error(streamMessage));
            } finally {
              rateLimitLease?.release();
              rateLimitLease = null;
            }
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        }
      );
    } catch (primaryErr: unknown) {
      if (model !== PREMIUM_MODEL) {
        rateLimitLease?.release();
        rateLimitLease = null;
        throw primaryErr;
      }

      const primaryMessage = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      debugLog(requestId, 'premium_failed_fallback_to_basic', {
        premiumError: clipText(primaryMessage),
      });

      const fallbackStream = await createChatCompletion(apiKey, BASIC_MODEL, chatMessages, requestId);
      responseModel = BASIC_MODEL;

      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            try {
              const sendEvent = (payload: Record<string, unknown>) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
              };

              controller.enqueue(encoder.encode(': stream-open\n\n'));

              for await (const event of fallbackStream) {
                const deltaNode = event?.choices?.[0]?.delta;
                const contentDelta = normalizeDeltaText(deltaNode?.content);
                const reasoningDelta =
                  normalizeDeltaText(deltaNode?.reasoning) ||
                  normalizeDeltaText(deltaNode?.reasoning_content) ||
                  normalizeDeltaText(deltaNode?.reasoningContent);

                if (reasoningDelta) {
                  sendEvent({ type: 'reasoning', delta: reasoningDelta });
                }

                if (contentDelta) {
                  assistantResponse += contentDelta;
                  sendEvent({ type: 'content', delta: contentDelta });
                }
              }

              if (assistantResponse.trim()) {
                const responseCost = isFollowUp ? FOLLOW_UP_CREDIT_COST : calculateCreditCost(pageCount, responseModel);
                await finalizeAssistantResponse({
                  supabase,
                  apiKey,
                  sessionId: session.id,
                  userId: user.id,
                  filePath,
                  fileName,
                  assistantResponse,
                  currentCredits,
                  responseCost,
                  responseModel,
                  promptContext,
                  originalQuestion: message,
                  isFollowUp,
                  requestId,
                  sendEvent,
                });
              }

              sendEvent({ type: 'done' });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));

              debugLog(requestId, 'response_saved', { sessionId: session.id, responseModel });
              controller.close();
            } catch (streamErr: unknown) {
              const streamMessage = streamErr instanceof Error ? streamErr.message : 'Streaming failed';
              controller.error(new Error(streamMessage));
            } finally {
              rateLimitLease?.release();
              rateLimitLease = null;
            }
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          },
        }
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unexpected chat error';
    rateLimitLease?.release();
    const errorDetails = {
      requestId,
      message,
      type: err instanceof Error ? err.constructor.name : typeof err,
      stack: err instanceof Error ? err.stack : undefined,
    };
    console.error(`[chat:${requestId}] request_failed`, errorDetails);
    return json({ error: message }, { status: 500 });
  }
};
