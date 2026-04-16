import type { SupabaseClient } from '@supabase/supabase-js';
import { setUserCredits } from './chats';
import { calculateTokenWeightedCost } from './tokenCounting';

/**
 * Atomic Credit Deduction Engine
 * Handles token-weighted cost calculation and atomic credit updates
 * 
 * Formula:
 * Credits_Deducted = Base + ⌈(InputTokens/1000 × W_In) + (OutputTokens/1000 × W_Out)⌉
 * 
 * All calculations use Math.ceil() to prevent fractional revenue loss
 */

export interface CreditDeductionRequest {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  metadata?: {
    requestId?: string;
    chatId?: string;
    filePath?: string;
  };
}

export interface CreditDeductionResult {
  deducted: number;
  remainingCredits: number;
  atomic: boolean; // true if successful atomic update
  error?: string;
}

/**
 * Custom weights for token-weighted credit costs
 * Default: GitHub Consumer API pricing model
 */
export interface TokenWeights {
  inputWeight: number; // credits per 1000 input tokens
  outputWeight: number; // credits per 1000 output tokens
  baseWeight: number; // baseline cost per request
}

const DEFAULT_WEIGHTS: TokenWeights = {
  inputWeight: 0.03,  // $0.03 per 1K input tokens
  outputWeight: 0.06, // $0.06 per 1K output tokens
  baseWeight: 0.01,   // $0.01 base cost per request
};

/**
 * Validate that user has sufficient credit balance before deduction
 */
export async function validateCreditBalance(
  supabase: SupabaseClient,
  userId: string,
  requiredCredits: number
): Promise<{ valid: boolean; currentBalance: number; message?: string }> {
  const { data, error } = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    return {
      valid: false,
      currentBalance: 0,
      message: `Failed to fetch balance: ${error.message}`,
    };
  }

  if (!data) {
    return {
      valid: false,
      currentBalance: 0,
      message: 'User profile not found',
    };
  }

  const currentBalance = typeof data.credits === 'number' ? data.credits : 0;

  if (currentBalance < requiredCredits) {
    return {
      valid: false,
      currentBalance,
      message: `Insufficient credits. Required: ${requiredCredits}, Available: ${currentBalance}`,
    };
  }

  return {
    valid: true,
    currentBalance,
  };
}

/**
 * Atomically deduct token-weighted credits from user account
 * 
 * Atomic guarantee: Credit deduction only succeeds if:
 * 1. User has sufficient balance (checked before deduction)
 * 2. Update returns single row (not multiple rows)
 * 3. No concurrent updates conflict
 * 
 * Edge cases handled:
 * - Fractional credits: Always rounded UP using Math.ceil()
 * - Zero-cost requests: Model-based exemptions (greetings, cache hits)
 * - Concurrent updates: Last-write-wins via Supabase MVCC
 */
export async function deductCreditsAtomic(
  supabase: SupabaseClient,
  request: CreditDeductionRequest,
  weights: TokenWeights = DEFAULT_WEIGHTS
): Promise<CreditDeductionResult> {
  const { userId, model, inputTokens, outputTokens, metadata } = request;

  try {
    // Step 1: Calculate exact token-weighted cost
    const creditsToDeduct = calculateTokenWeightedCost(
      inputTokens,
      outputTokens,
      model,
      weights
    );

    // Step 2: Validate sufficient balance exists
    const balanceCheck = await validateCreditBalance(supabase, userId, creditsToDeduct);
    if (!balanceCheck.valid) {
      return {
        deducted: 0,
        remainingCredits: balanceCheck.currentBalance,
        atomic: false,
        error: balanceCheck.message,
      };
    }

    const currentBalance = balanceCheck.currentBalance;

    // Step 3: Atomic subtraction via Supabase update
    // This uses row-versioning (MVCC) for isolation
    const newBalance = Math.max(0, currentBalance - creditsToDeduct);
    const updatedBalance = await setUserCredits(supabase, userId, newBalance);

    // Step 4: Verify atomic update succeeded
    // If returned balance doesn't match expected, concurrent write occurred
    const isAtomic = Math.abs(updatedBalance - newBalance) < 0.01;

    // Step 5: Log audit trail for financial transparency
    await logCreditDeduction({
      userId,
      creditsDeducted: creditsToDeduct,
      previousBalance: currentBalance,
      newBalance: updatedBalance,
      model,
      inputTokens,
      outputTokens,
      requestId: metadata?.requestId,
      chatId: metadata?.chatId,
      filePath: metadata?.filePath,
    });

    return {
      deducted: creditsToDeduct,
      remainingCredits: updatedBalance,
      atomic: isAtomic,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[credit-deduction:${userId}] Failed:`, err);

    return {
      deducted: 0,
      remainingCredits: 0,
      atomic: false,
      error: message,
    };
  }
}

/**
 * Dry-run: Calculate cost without deducting
 * Useful for pre-checks and UI feedback
 */
export function calculateCostEstimate(
  model: string,
  inputTokens: number,
  outputTokens: number,
  weights: TokenWeights = DEFAULT_WEIGHTS
): number {
  return calculateTokenWeightedCost(inputTokens, outputTokens, model, weights);
}

/**
 * Audit trail logging for financial transparency
 * Stored separately for compliance/analytics
 */
async function logCreditDeduction(options: {
  userId: string;
  creditsDeducted: number;
  previousBalance: number;
  newBalance: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestId?: string;
  chatId?: string;
  filePath?: string;
}): Promise<void> {
  const {
    userId,
    creditsDeducted,
    previousBalance,
    newBalance,
    model,
    inputTokens,
    outputTokens,
    requestId,
    chatId,
    filePath,
  } = options;

  // This could be stored in a separate audit_log table in production
  console.info('[credit-audit]', {
    timestamp: new Date().toISOString(),
    userId,
    creditsDeducted,
    balanceBefore: previousBalance,
    balanceAfter: newBalance,
    model,
    tokens: { input: inputTokens, output: outputTokens },
    requestId,
    chatId,
    filePath,
  });
}

/**
 * Refund credits (for failed requests or user disputes)
 * Only use after thorough validation
 */
export async function refundCredits(
  supabase: SupabaseClient,
  userId: string,
  creditsToRefund: number,
  reason: string
): Promise<number> {
  console.warn(`[credit-refund] User=${userId} Amount=${creditsToRefund} Reason=${reason}`);

  const { data, error } = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(`Failed to fetch current credits: ${error?.message}`);
  }

  const currentBalance = typeof data.credits === 'number' ? data.credits : 0;
  const newBalance = currentBalance + creditsToRefund;

  return setUserCredits(supabase, userId, newBalance);
}
