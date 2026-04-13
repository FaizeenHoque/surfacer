import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY } from '$env/static/public';

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatSessionRow = {
  id: string;
  user_id: string;
  file_path: string;
  file_name: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatMessageRow = {
  id: string;
  chat_id: string;
  user_id: string;
  role: ChatRole;
  content: string;
  created_at: string;
};

export type ExtractionRunRow = {
  id: string;
  user_id: string;
  chat_id: string | null;
  file_path: string;
  file_name: string;
  prompt: string;
  result: string;
  created_at: string;
};

export function createAuthedSupabase(token: string) {
  return createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

export async function getUserFromToken(supabase: SupabaseClient, token: string) {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw new Error('Invalid auth token');
  }

  return user;
}

export function fileNameFromPath(filePath: string) {
  return filePath.split('/').pop() || 'document';
}

export async function getOrCreateChatSession(
  supabase: SupabaseClient,
  userId: string,
  filePath: string,
  fileName: string
) {
  const { data: existing, error: lookupError } = await supabase
    .from('chat_sessions')
    .select('id, user_id, file_path, file_name, title, created_at, updated_at')
    .eq('user_id', userId)
    .eq('file_path', filePath)
    .maybeSingle();

  if (lookupError) {
    throw lookupError;
  }

  if (existing) {
    return existing as ChatSessionRow;
  }

  const { data, error } = await supabase
    .from('chat_sessions')
    .insert({
      user_id: userId,
      file_path: filePath,
      file_name: fileName,
      title: fileName,
    })
    .select('id, user_id, file_path, file_name, title, created_at, updated_at')
    .single();

  if (error || !data) {
    throw error || new Error('Failed to create chat session');
  }

  return data as ChatSessionRow;
}

export async function listChatMessages(supabase: SupabaseClient, chatId: string) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, chat_id, user_id, role, content, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) {
    throw error;
  }

  return (data || []) as ChatMessageRow[];
}

export async function appendChatMessage(
  supabase: SupabaseClient,
  chatId: string,
  userId: string,
  role: ChatRole,
  content: string
) {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      chat_id: chatId,
      user_id: userId,
      role,
      content,
    })
    .select('id, chat_id, user_id, role, content, created_at')
    .single();

  if (error || !data) {
    throw error || new Error('Failed to save chat message');
  }

  return data as ChatMessageRow;
}

export async function saveExtractionRun(
  supabase: SupabaseClient,
  input: {
    userId: string;
    chatId?: string | null;
    filePath: string;
    fileName: string;
    prompt: string;
    result: string;
  }
) {
  const { data, error } = await supabase
    .from('extraction_runs')
    .insert({
      user_id: input.userId,
      chat_id: input.chatId || null,
      file_path: input.filePath,
      file_name: input.fileName,
      prompt: input.prompt,
      result: input.result,
    })
    .select('id, user_id, chat_id, file_path, file_name, prompt, result, created_at')
    .single();

  if (error || !data) {
    throw error || new Error('Failed to save extraction run');
  }

  return data as ExtractionRunRow;
}

export async function listExtractionRuns(
  supabase: SupabaseClient,
  input: {
    userId: string;
    searchQuery?: string;
    days?: number;
    limit?: number;
  }
) {
  const days = Math.max(1, Math.min(input.days || 30, 90));
  const limit = Math.max(1, Math.min(input.limit || 100, 300));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('extraction_runs')
    .select('id, user_id, chat_id, file_path, file_name, prompt, result, created_at')
    .eq('user_id', input.userId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(limit);

  const term = (input.searchQuery || '').trim();
  if (term) {
    const escaped = term.replace(/[%_,]/g, (char) => `\\${char}`);
    const pattern = `%${escaped}%`;
    query = query.or(`file_name.ilike.${pattern},prompt.ilike.${pattern},result.ilike.${pattern}`);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return (data || []) as ExtractionRunRow[];
}

export async function getUserCredits(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('credits')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return 0;
  }

  if (typeof data.credits === 'number') {
    return data.credits;
  }

  if (typeof data.credits === 'string') {
    const parsed = Number(data.credits);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

export async function setUserCredits(supabase: SupabaseClient, userId: string, credits: number) {
  const nextCredits = Math.max(0, Number(credits.toFixed(2)));
  const { error } = await supabase
    .from('profiles')
    .update({ credits: nextCredits })
    .eq('id', userId);

  if (error) {
    throw error;
  }

  return nextCredits;
}

export type UserSubscriptionTracking = {
  subscriptionId: string;
  subscriptionStatus: string;
};

function isMissingSubscriptionTrackingColumn(error: unknown) {
  if (!error || typeof error !== 'object') return false;

  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';

  if (code === '42703') return true;
  return message.includes('subscription_id') || message.includes('subscription_status');
}

export async function getUserSubscriptionTracking(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('subscription_id, subscription_status')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    if (isMissingSubscriptionTrackingColumn(error)) {
      return null;
    }
    throw error;
  }

  if (!data) {
    return null;
  }

  const subscriptionId = typeof data.subscription_id === 'string' ? data.subscription_id.trim() : '';
  const subscriptionStatus = typeof data.subscription_status === 'string' ? data.subscription_status.trim() : '';

  if (!subscriptionId) {
    return null;
  }

  return {
    subscriptionId,
    subscriptionStatus,
  } as UserSubscriptionTracking;
}

export async function setUserSubscriptionTracking(
  supabase: SupabaseClient,
  userId: string,
  subscriptionId: string,
  subscriptionStatus?: string
) {
  const nextSubscriptionId = subscriptionId.trim();
  const nextSubscriptionStatus = (subscriptionStatus || '').trim();

  const { error } = await supabase
    .from('profiles')
    .update({
      subscription_id: nextSubscriptionId || null,
      subscription_status: nextSubscriptionStatus || null,
    })
    .eq('id', userId);

  if (error) {
    if (isMissingSubscriptionTrackingColumn(error)) {
      return;
    }
    throw error;
  }
}

export async function clearUserSubscriptionTracking(supabase: SupabaseClient, userId: string) {
  const { error } = await supabase
    .from('profiles')
    .update({
      subscription_id: null,
      subscription_status: null,
    })
    .eq('id', userId);

  if (error) {
    if (isMissingSubscriptionTrackingColumn(error)) {
      return;
    }
    throw error;
  }
}
