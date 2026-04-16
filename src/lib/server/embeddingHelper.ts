import { env } from '$env/dynamic/private';

const EMBEDDING_MODEL = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
const OPENROUTER_EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings';

interface EmbeddingResponse {
  object: string;
  index: number;
  embedding: number[];
}

interface EmbeddingsResult {
  data: EmbeddingResponse[];
  model: string;
}

/**
 * Generate embedding vector for a text query using OpenRouter API
 * Returns null on failure to allow graceful degradation
 */
export async function getQueryEmbedding(text: string): Promise<number[] | null> {
  try {
    const apiKey = env.OPENROUTER_API_KEY || '';
    if (!apiKey) {
      console.warn('⚠️ Embedding Helper: Missing OPENROUTER_API_KEY');
      return null;
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
        input: [text],
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn(`⚠️ Embedding Helper: API error ${response.status}:`, error);
      return null;
    }

    const data = (await response.json()) as EmbeddingsResult;

    if (!data.data || data.data.length === 0 || !data.data[0].embedding) {
      console.warn('⚠️ Embedding Helper: Invalid response structure');
      return null;
    }

    return data.data[0].embedding;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn('⚠️ Embedding Helper: Failed to generate embedding:', message);
    return null;
  }
}

/**
 * Generate embeddings for multiple texts
 * Returns array of embeddings or nulls on failure for each text
 */
export async function getMultipleEmbeddings(texts: string[]): Promise<(number[] | null)[]> {
  try {
    const apiKey = env.OPENROUTER_API_KEY || '';
    if (!apiKey) {
      console.warn('⚠️ Embedding Helper: Missing OPENROUTER_API_KEY');
      return texts.map(() => null);
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
        input: texts,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.warn(`⚠️ Embedding Helper: API error ${response.status}:`, error);
      return texts.map(() => null);
    }

    const data = (await response.json()) as EmbeddingsResult;

    if (!data.data || data.data.length !== texts.length) {
      console.warn('⚠️ Embedding Helper: Response count mismatch');
      return texts.map(() => null);
    }

    // Sort by index to maintain order
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding || null);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.warn('⚠️ Embedding Helper: Failed to generate embeddings:', message);
    return texts.map(() => null);
  }
}
