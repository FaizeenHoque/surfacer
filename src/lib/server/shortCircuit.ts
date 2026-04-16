/**
 * Zero-Token Short-Circuit Filter
 * Detects greetings and trivial inputs that require no LLM processing
 * Cost: $0 (hardcoded responses only)
 *
 * Prevents unnecessary LLM calls for:
 * - Greetings (Hi, Hello, Hey, etc.)
 * - Thanks/Gratitude
 * - Simple acknowledgments
 * - Repeated patterns
 */

type ShortCircuitResponse = {
  triggered: boolean;
  response?: string;
  type?: 'greeting' | 'gratitude' | 'trivial';
};

const GREETING_PATTERNS = [
  /^(hi|hello|hey|sup|howdy|greetings|welcome)(?:\s|$|!|\?)/i,
  /^(what'?s up|how'?s it going|what's new|how are you)\??$/i,
  /^(good morning|good afternoon|good evening|good night)\s?$/i,
];

const GRATITUDE_PATTERNS = [
  /^(thanks|thank you|thx|thnx|ty|appreciated|appreciate it)(?:\s|!|$|\?)/i,
  /^(much appreciated|very helpful|thanks a lot|thank you so much)/i,
  /^(that'?s helpful|that'?s useful|great help)(?:\s|!|$|\?)/i,
];

const TRIVIAL_PATTERNS = [
  /^(ok|okay|alright|sure|yep|nope|nah|yeah|uh huh|umm?|er+|hmm+)(?:\s|!|$|\?)/i,
  /^(i see|i understand|got it|understood|copy that)/i,
  /^(cool|nice|great|awesome|excellent|good)(?:\s|!|$|\?)/i,
];

const HARDCODED_RESPONSES: Record<string, string> = {
  greeting:
    "Hi! I'm Surfacer, your document AI assistant. Upload a file and ask me questions about it. I'll answer directly from the document with page citations.",
  gratitude: "Happy to help! Feel free to ask more questions about your document.",
  trivial: "I'm listening! What else would you like to know about the document?",
};

/**
 * Check if input should short-circuit (no LLM call needed)
 */
export function tryShortCircuit(userInput: string): ShortCircuitResponse {
  const trimmed = userInput.trim();

  // Check greetings
  for (const pattern of GREETING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        triggered: true,
        type: 'greeting',
        response: HARDCODED_RESPONSES.greeting,
      };
    }
  }

  // Check gratitude
  for (const pattern of GRATITUDE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        triggered: true,
        type: 'gratitude',
        response: HARDCODED_RESPONSES.gratitude,
      };
    }
  }

  // Check trivial acknowledgments (only very short inputs)
  if (trimmed.length < 15) {
    for (const pattern of TRIVIAL_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          triggered: true,
          type: 'trivial',
          response: HARDCODED_RESPONSES.trivial,
        };
      }
    }
  }

  return { triggered: false };
}

/**
 * Log short-circuit events for analytics
 */
export function logShortCircuit(
  userId: string,
  type: ShortCircuitResponse['type'],
  input: string,
  requestId: string
): void {
  console.info(`[short-circuit:${requestId}] User=${userId} Type=${type} Input="${input.slice(0, 30)}"`, {
    type,
    inputLength: input.length,
  });
}
