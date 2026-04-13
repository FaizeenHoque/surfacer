<script lang="ts">
  import { onMount } from 'svelte';

  type SharedMessage = {
    id: string;
    type: 'system' | 'user' | 'ai';
    text?: string;
    content?: string;
    timestamp?: string;
  };

  type SharePayload = {
    fileName?: string;
    sharedAt?: string;
    messages?: SharedMessage[];
  };

  let loading = $state(true);
  let error = $state('');
  let fileName = $state('Shared chat');
  let messages = $state<SharedMessage[]>([]);

  onMount(() => {
    const init = async () => {
      try {
        const id = window.location.pathname.split('/').pop() || '';
        const response = await fetch(`/api/chat/share/${encodeURIComponent(id)}`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Unable to load shared chat');
        }

        const payload = (data.payload || {}) as SharePayload;
        fileName = payload.fileName || data.fileName || 'Shared chat';
        messages = Array.isArray(payload.messages) ? payload.messages : [];
      } catch (err: unknown) {
        error = err instanceof Error ? err.message : 'Unable to load shared chat';
      } finally {
        loading = false;
      }
    };

    void init();
  });
</script>

<div class="share-shell">
  <div class="share-card">
    <h1>{fileName}</h1>
    {#if loading}
      <p class="muted">Loading shared chat...</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else if messages.length === 0}
      <p class="muted">No messages in this shared chat.</p>
    {:else}
      <div class="messages">
        {#each messages as msg (msg.id)}
          <div class="msg" data-type={msg.type}>
            <p class="meta">{msg.type === 'ai' ? 'Surfacer' : msg.type === 'user' ? 'User' : 'System'}{msg.timestamp ? ` · ${msg.timestamp}` : ''}</p>
            <p>{msg.type === 'system' ? msg.text : msg.content}</p>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  :global(body) {
    margin: 0;
    background: #080a0f;
    color: #e6e8f1;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
  }

  .share-shell {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 1.25rem;
  }

  .share-card {
    width: min(900px, 100%);
    border: 1px solid #ffffff1a;
    border-radius: 16px;
    background: #111521;
    padding: 1.1rem;
  }

  h1 {
    margin: 0 0 0.9rem;
    font-size: 1.1rem;
  }

  .messages {
    display: grid;
    gap: 0.7rem;
  }

  .msg {
    border: 1px solid #ffffff14;
    border-radius: 12px;
    padding: 0.75rem;
    background: #0f1320;
  }

  .msg[data-type='user'] {
    background: #122014;
    border-color: #1d3722;
  }

  .msg[data-type='system'] {
    background: #1d1420;
    border-color: #3d2440;
  }

  .meta {
    margin: 0 0 0.3rem;
    font-size: 0.76rem;
    color: #8f96ad;
  }

  p {
    margin: 0;
    white-space: pre-wrap;
    line-height: 1.45;
  }

  .muted {
    color: #95a0c2;
  }

  .error {
    color: #fca5a5;
  }
</style>
