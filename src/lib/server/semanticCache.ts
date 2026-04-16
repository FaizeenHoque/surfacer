import { env } from '$env/dynamic/private';

export interface CachedAnswer {
  query: string;
  queryEmbedding: number[];
  answer: string;
  metadata: {
    fileId: string;
    fileName: string;
    createdAt: string;
    model: string;
  };
}

interface UpstashRedisResponse<T> {
  result: T;
  error?: string;
}

/**
 * Semantic Cache Gate using Upstash Redis
 * Caches answers for queries with >95% cosine similarity
 * Returns $0 cost for cache hits
 */
export class SemanticCache {
  private redisUrl: string;
  private redisToken: string;
  private similarity_threshold = 0.95;

  constructor() {
    this.redisUrl = env.UPSTASH_REDIS_REST_URL || '';
    this.redisToken = env.UPSTASH_REDIS_REST_TOKEN || '';

    if (!this.redisUrl || !this.redisToken) {
      console.warn('⚠️ Semantic Cache: Missing Upstash credentials. Cache disabled.');
    }
  }

  private isEnabled(): boolean {
    return Boolean(this.redisUrl && this.redisToken);
  }

  /**
   * Compute cosine similarity between two embedding vectors
   * Range: [-1, 1], where 1.0 = perfect match
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Query cache for similar answers
   * Returns answer if similarity > 95%
   * Cost: $0 on hit, $0.01 on miss (Redis call)
   */
  async querySimilar(
    queryEmbedding: number[],
    userId: string,
    fileId: string
  ): Promise<{
    hit: boolean;
    answer?: string;
    similarity?: number;
  }> {
    if (!this.isEnabled()) {
      return { hit: false };
    }

    try {
      const cacheKey = `cache:${userId}:${fileId}:*`;
      
      // Get all cached queries for this user+file combination
      const response = await fetch(`${this.redisUrl}/scan/cursor`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.redisToken}`,
        },
        body: JSON.stringify({
          cursor: 0,
          match: cacheKey,
          count: 10,
        }),
      });

      const scanResult = await response.json() as UpstashRedisResponse<[string, string[]]>;
      if (scanResult.error || !scanResult.result) {
        return { hit: false };
      }

      const keys = scanResult.result[1] || [];
      if (keys.length === 0) {
        return { hit: false };
      }

      // Get all cached entries and compute similarities
      for (const key of keys) {
        const getResponse = await fetch(`${this.redisUrl}/get/${key}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.redisToken}`,
          },
        });

        const cached = await getResponse.json() as UpstashRedisResponse<string>;
        if (cached.error || !cached.result) continue;

        const entry: CachedAnswer = JSON.parse(cached.result);
        const similarity = this.cosineSimilarity(queryEmbedding, entry.queryEmbedding);

        if (similarity >= this.similarity_threshold) {
          return {
            hit: true,
            answer: entry.answer,
            similarity,
          };
        }
      }

      return { hit: false };
    } catch (err) {
      console.error('Cache query failed:', err);
      return { hit: false };
    }
  }

  /**
   * Store answer in cache
   * TTL: 30 days (2.592M seconds)
   */
  async store(
    queryEmbedding: number[],
    query: string,
    answer: string,
    userId: string,
    fileId: string,
    fileName: string,
    model: string
  ): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      const cacheKey = `cache:${userId}:${fileId}:${Date.now()}`;
      const entry: CachedAnswer = {
        query,
        queryEmbedding,
        answer,
        metadata: {
          fileId,
          fileName,
          createdAt: new Date().toISOString(),
          model,
        },
      };

      await fetch(`${this.redisUrl}/set/${cacheKey}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.redisToken}`,
        },
        body: JSON.stringify({
          nx: false, // overwrite if exists
          ex: 2592000, // 30 days TTL
          get: false,
        }),
      });

      // Store serialized value
      await fetch(`${this.redisUrl}/mset`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.redisToken}`,
        },
        body: JSON.stringify({
          [cacheKey]: JSON.stringify(entry),
        }),
      });

      return true;
    } catch (err) {
      console.error('Cache store failed:', err);
      return false;
    }
  }

  /**
   * Invalidate cache for a specific file
   * Called when file is updated or deleted
   */
  async invalidate(userId: string, fileId: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const cacheKey = `cache:${userId}:${fileId}:*`;
      
      // Scan and delete all matching keys
      const response = await fetch(`${this.redisUrl}/scan/cursor`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.redisToken}`,
        },
        body: JSON.stringify({
          cursor: 0,
          match: cacheKey,
          count: 100,
        }),
      });

      const scanResult = await response.json() as UpstashRedisResponse<[string, string[]]>;
      const keys = scanResult.result?.[1] || [];

      for (const key of keys) {
        await fetch(`${this.redisUrl}/del/${key}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.redisToken}`,
          },
        });
      }
    } catch (err) {
      console.error('Cache invalidation failed:', err);
    }
  }
}

export const semanticCache = new SemanticCache();
