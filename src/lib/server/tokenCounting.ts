/**
 * Token Counting Utility
 * Accurate token estimation for both GPT-4 and open-source models
 * 
 * Supports:
 * - OpenRouter models (Phi-4, DeepSeek-V3)
 * - Consistent token math across different model families
 * - Estimated counts using approximation (1 token ≈ 4 chars)
 */

type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type ModelConfig = {
  name: string;
  tokenScale: number; // adjustment factor for accuracy
  supportedTokenEstimate: boolean;
};

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'microsoft/Phi-4': {
    name: 'Microsoft Phi-4',
    tokenScale: 1.0,
    supportedTokenEstimate: true,
  },
  'deepseek/DeepSeek-V3-0324': {
    name: 'DeepSeek-V3',
    tokenScale: 1.05, // slightly higher token count
    supportedTokenEstimate: true,
  },
};

/**
 * Estimate tokens for text using reasonable approximation
 * Based on: 1 token ≈ 4 characters (GPT-compatible)
 * Range: ±5% variance
 */
function estimateTokenCount(text: string, tokenScale: number = 1.0): number {
  if (!text) return 0;
  
  // Base calculation: ~4 chars per token
  const baseTokens = Math.ceil(text.length / 4);
  
  // Apply model-specific scale
  return Math.max(1, Math.ceil(baseTokens * tokenScale));
}

/**
 * Count tokens in messages array (typical chat format)
 * Accounts for:
 * - JSON serialization overhead (~4-6%)
 * - Message role tokens (system/user/assistant = ~3-5 tokens each)
 * - Special token markers
 */
export function countTokensInMessages(
  messages: Array<{ role: string; content: string }>,
  model: string = 'microsoft/Phi-4'
): TokenCounts {
  const config = MODEL_CONFIGS[model];
  const tokenScale = config?.tokenScale || 1.0;

  let inputTokens = 0;

  // Add tokens for each message
  for (const msg of messages) {
    // Role token (~4-5 tokens for role name)
    inputTokens += 5;
    
    // Content tokens
    inputTokens += estimateTokenCount(msg.content, tokenScale);
    
    // Special markers and separators (~2 tokens)
    inputTokens += 2;
  }

  // Add overhead for message formatting (~3% for JSON structure)
  inputTokens = Math.ceil(inputTokens * 1.03);

  return {
    inputTokens,
    outputTokens: 0, // Will be counted separately
    totalTokens: inputTokens,
  };
}

/**
 * Estimate output tokens for a response
 * Typically 30-40% of input for Q&A tasks
 */
export function estimateOutputTokens(
  maxCompletionTokens: number = 1024,
  model: string = 'microsoft/Phi-4'
): number {
  const config = MODEL_CONFIGS[model];
  const tokenScale = config?.tokenScale || 1.0;

  // Assume LLM uses ~50-70% of allowed max_completion_tokens
  const avgUtilization = 0.6;
  const estimated = Math.ceil(maxCompletionTokens * avgUtilization * tokenScale);

  return estimated;
}

/**
 * Full token calculation for a chat request+response cycle
 */
export function calculateRequestTokens(options: {
  messages: Array<{ role: string; content: string }>;
  maxCompletionTokens?: number;
  model?: string;
}): TokenCounts {
  const {
    messages,
    maxCompletionTokens = 1024,
    model = 'microsoft/Phi-4',
  } = options;

  const input = countTokensInMessages(messages, model);
  const output = estimateOutputTokens(maxCompletionTokens, model);

  return {
    inputTokens: input.inputTokens,
    outputTokens: output,
    totalTokens: input.inputTokens + output,
  };
}

/**
 * Calculate actual cost using token-weighted formula
 * Credit calculation: Base + Token Cost
 * 
 * Formula:
 * Credits = Model_Base + ⌈(InputTokens/1000 × W_In) + (OutputTokens/1000 × W_Out)⌉
 * 
 * Example weights for GitHub Consumer API:
 * - Input: $0.03/1M tokens = 0.00003 per token
 * - Output: $0.06/1M tokens = 0.00006 per token
 * - Base: 0.01 (baseline system cost)
 * 
 * @param inputTokens Estimated input tokens
 * @param outputTokens Estimated output tokens
 * @param model Model name for multiplier lookup
 * @param weights Token cost weights {inputWeight, outputWeight, baseWeight}
 */
export function calculateTokenWeightedCost(
  inputTokens: number,
  outputTokens: number,
  model: string = 'microsoft/Phi-4',
  weights: {
    inputWeight: number; // credits per 1000 input tokens
    outputWeight: number; // credits per 1000 output tokens
    baseWeight: number; // baseline credit cost
  } = {
    inputWeight: 0.03,  // $0.03 per 1K input tokens
    outputWeight: 0.06, // $0.06 per 1K output tokens
    baseWeight: 0.01,   // $0.01 base cost per request
  }
): number {
  const { inputWeight, outputWeight, baseWeight } = weights;

  // Model premium: DeepSeek (reasoning) costs 10x more
  const modelMultiplier = model.includes('DeepSeek') ? 10 : 1;

  // Calculate token costs
  const inputCost = (inputTokens / 1000) * inputWeight;
  const outputCost = (outputTokens / 1000) * outputWeight;
  
  // Total = Base + Input + Output, all multiplied by model factor
  const totalCost = (baseWeight + inputCost + outputCost) * modelMultiplier;

  // Use Math.ceil() to prevent fractional revenue loss
  return Math.ceil(totalCost * 100) / 100; // Round to 2 decimals
}

/**
 * Get model info for UI/debugging
 */
export function getModelInfo(model: string): ModelConfig | null {
  return MODEL_CONFIGS[model] || null;
}

/**
 * List all supported models
 */
export function getSupportedModels(): string[] {
  return Object.keys(MODEL_CONFIGS);
}
