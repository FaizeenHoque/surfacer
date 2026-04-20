-- Add credits_used column to chat_messages to track credit consumption per message
alter table public.chat_messages
  add column if not exists credits_used numeric(10, 2);

-- Add comment to document the column
comment on column public.chat_messages.credits_used is 'Number of credits used for this message response (only populated for AI responses)';
