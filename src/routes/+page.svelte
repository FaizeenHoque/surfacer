<script lang="ts">
  import { tick } from 'svelte';
  import { authStore } from '$lib/authStore';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  // ── State ──────────────────────────────────────────────────────────────────
  let sidebarOpen = $state(true);
  let activeFile = $state<string | null>(null);
  let promptValue = $state('');
  let isThinking = $state(false);
  let messages = $state<Message[]>([]);
  let currentUser = $state<any>(null);

  let messagesEl: HTMLElement;
  let textareaEl: HTMLTextAreaElement;

  type Message =
    | { type: 'system'; text: string }
    | { type: 'ai'; content: string; timestamp: string; streaming?: boolean }
    | { type: 'user'; content: string; timestamp: string };

  // ── Files data ─────────────────────────────────────────────────────────────
  let files = $state<Array<{ name: string; ext: string; size: string; extractions: number; color: string }>>([]);
  let templates = $state<string[]>([]);

  // ── Init ────────────────────────────────────────────────────────────────────
  onMount(async () => {
    const user = await authStore.checkUser();
    if (user) {
      currentUser = user;
    } else {
      goto('/auth');
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function simpleMarkdown(text: string) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^/, '<p>')
      .replace(/$/, '</p>');
  }

  function scrollToBottom() {
    tick().then(() => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function selectFile(name: string) {
    activeFile = name;
    messages = [{ type: 'system', text: `${name} loaded` }];
  }

  async function sendMessage() {
    const text = promptValue.trim();
    if (!text || isThinking) return;
    promptValue = '';
    if (textareaEl) { textareaEl.style.height = 'auto'; }

    messages = [...messages, { type: 'user', content: text, timestamp: 'just now' }];
    isThinking = true;
    scrollToBottom();

    // TODO: Implement API call to backend
    await new Promise(r => setTimeout(r, 900));
    isThinking = false;
  }

  function handleKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  }

  async function handleLogout() {
    try {
      await authStore.logout();
      goto('/auth');
    } catch (err: unknown) {
      console.error('Logout failed:', err);
    }
  }

  function openAccountSettings() {
    window.location.href = '/auth/change-email';
  }
</script>

<!-- ════════════════════════════ ROOT ════════════════════════════ -->
<div class="grain h-screen flex overflow-hidden font-sans text-white" style="background:#09090d">

  <!-- ═══ SIDEBAR ═══ -->
  <aside
    class="shrink-0 flex flex-col border-r h-full overflow-hidden transition-all duration-300"
    style="width:{sidebarOpen ? '256px' : '0px'}; opacity:{sidebarOpen ? 1 : 0}; background:#111116; border-color:#ffffff0d"
  >
    <!-- Logo -->
    <div class="px-5 py-4 flex items-center justify-between" style="border-bottom:1px solid #ffffff0d">
      <div class="flex items-center gap-2.5">
        <div class="w-7 h-7 rounded-lg flex items-center justify-center" style="background:#00e5a014; border:1px solid #00e5a026">
          <svg class="w-3.5 h-3.5" style="color:#00e5a0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <span class="text-sm font-semibold tracking-tight">Surfacer</span>
      </div>
      <button onclick={() => sidebarOpen = false} title="Close sidebar" class="p-1 rounded transition-colors" style="color:#4a4a5e" onmouseenter={e => (e.currentTarget as HTMLElement).style.color='white'} onmouseleave={e => (e.currentTarget as HTMLElement).style.color='#4a4a5e'}>
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M11 19l-7-7 7-7"/>
        </svg>
      </button>
    </div>

    <!-- Upload btn -->
    <div class="px-4 pt-4 pb-2">
      <button class="upload-btn w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed text-xs font-mono tracking-wide transition-all duration-200" style="border-color:#ffffff16; color:#4a4a5e">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
        </svg>
        Upload Document
      </button>
    </div>

    <!-- Search -->
    <div class="px-4 pb-3">
      <div class="flex items-center gap-2 px-3 py-2 rounded-lg" style="background:#18181e; border:1px solid #ffffff0d">
        <svg class="w-3 h-3 shrink-0" style="color:#4a4a5e" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input type="text" placeholder="Search files" class="bg-transparent text-xs font-mono text-white placeholder-muted w-full duration-400 transition-all focus:ring-0" style="color:white" />
      </div>
    </div>

    <!-- Files label -->
    <div class="px-4 mb-2">
      <p class="text-[9px] font-mono tracking-[2px] uppercase" style="color:#4a4a5e">Documents</p>
    </div>

    <!-- File list -->
    <div class="flex-1 overflow-y-auto px-3 flex flex-col gap-1">
      {#each files as file (file.name)}
        <button
          onclick={() => selectFile(file.name)}
          class="file-item w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-all"
          style="border:1px solid {activeFile === file.name ? '#00e5a030' : '#ffffff0d'}; background:{activeFile === file.name ? '#00e5a010' : 'transparent'}"
        >
          <div class="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style="background:#18181e; border:1px solid #ffffff0d">
            <svg class="w-3.5 h-3.5 {file.color}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium truncate" style="color:{activeFile === file.name ? '#00e5a0' : 'rgba(255,255,255,0.8)'}">{file.name}</p>
            <p class="text-[10px] font-mono" style="color:#4a4a5e">{file.ext} · {file.size} · {file.extractions} extractions</p>
          </div>
        </button>
      {/each}

      <!-- Templates -->
      <div class="mt-4 mb-2">
        <p class="text-[9px] font-mono tracking-[2px] uppercase px-1" style="color:#4a4a5e">Templates</p>
      </div>
      {#each templates as tpl (tpl)}
        <button class="template-btn w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all" style="border:1px solid #ffffff0d">
          <svg class="w-3.5 h-3.5 shrink-0" style="color:#00e5a0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
          <span class="text-xs font-mono transition-colors" style="color:#4a4a5e">{tpl}</span>
        </button>
      {/each}
    </div>

    <!-- Footer -->
    <div class="p-4 flex flex-col gap-3" style="border-top:1px solid #ffffff0d">
      <!-- Credits -->
      <div class="px-3 py-2.5 rounded-lg" style="background:#18181e; border:1px solid #ffffff0d">
        <div class="flex items-center justify-between mb-1.5">
          <span class="text-[10px] font-mono" style="color:#4a4a5e">Credits remaining</span>
          <span class="text-[10px] font-mono font-medium" style="color:#00e5a0">0 / 100</span>
        </div>
        <div class="w-full rounded-full h-1" style="background:#2a2a38">
          <div class="h-1 rounded-full" style="width:0%; background:#00e5a0"></div>
        </div>
      </div>
      <button class="w-full py-2 rounded-lg text-xs font-mono font-medium transition-all duration-200" style="background:#00e5a014; border:1px solid #00e5a026; color:#00e5a0">
        + Buy credits
      </button>
      <!-- User -->
      {#if currentUser}
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 uppercase" style="background:#00e5a0; color:#09090d">
            {currentUser.email?.[0] || 'U'}
          </div>
          <div class="min-w-0">
            <p class="text-xs font-medium text-white truncate">{currentUser.email?.split('@')[0] || 'User'}</p>
            <p class="text-[10px] font-mono truncate" style="color:#4a4a5e">{currentUser.email || ''}</p>
          </div>
          <button
            title="Account settings"
            onclick={openAccountSettings}
            class="ml-auto p-1 transition-colors rounded"
            style="color:#4a4a5e"
            onmouseenter={e => (e.currentTarget as HTMLElement).style.color='white'}
            onmouseleave={e => (e.currentTarget as HTMLElement).style.color='#4a4a5e'}
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.757.426 1.757 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.757-2.924 1.757-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.757-.426-1.757-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
          </button>
          <button
            title="Logout"
            onclick={handleLogout}
            class="p-1 transition-colors rounded"
            style="color:#4a4a5e"
            onmouseenter={e => (e.currentTarget as HTMLElement).style.color='white'}
            onmouseleave={e => (e.currentTarget as HTMLElement).style.color='#4a4a5e'}
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
            </svg>
          </button>
        </div>
      {/if}
    </div>
  </aside>

  <!-- ═══ MAIN ═══ -->
  <main class="flex-1 flex flex-col h-full min-w-0" style="background:#09090d">

    <!-- Header -->
    <header class="shrink-0 flex items-center justify-between px-6 py-3.5 backdrop-blur-sm" style="border-bottom:1px solid #ffffff0d; background:rgba(17,17,22,0.6)">
      <div class="flex items-center gap-3">
        {#if !sidebarOpen}
          <button onclick={() => sidebarOpen = true} title="Toggle sidebar" class="p-1.5 rounded-lg transition-all" style="color:#4a4a5e">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/>
            </svg>
          </button>
        {/if}
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-full" style="background:#18181e; border:1px solid #ffffff0d">
          <svg class="w-3 h-3 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <span class="text-xs font-mono" style="color:rgba(255,255,255,0.8)">{activeFile}.pdf</span>
          <span class="text-[10px] font-mono" style="color:#4a4a5e">· 2.4 MB</span>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <select class="model-select text-xs font-mono px-3 py-1.5 rounded-lg outline-none cursor-pointer appearance-none pr-6 transition-all"
          style="background:#18181e; border:1px solid #ffffff0d; color:#4a4a5e">
          <option value="free">Free Model</option>
          <option value="enhanced">Enhanced (2cr)</option>
          <option value="premium">Premium (4cr)</option>
        </select>
        {#each [
          { title: 'Share', path: 'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z' },
          { title: 'Download', path: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4' },
        ] as btn (btn)}
          <button title={btn.title} class="p-2 rounded-lg transition-all" style="color:#4a4a5e">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d={btn.path}/>
            </svg>
          </button>
        {/each}
        <button title="Clear chat" onclick={() => { messages = []; }} class="p-2 rounded-lg transition-all" style="color:#4a4a5e">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- Messages -->
    <div bind:this={messagesEl} class="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-5">
      {#each messages as msg (msg)}
        {#if msg.type === 'system'}
          <div class="flex justify-center">
            <div class="flex items-center gap-2 px-4 py-2 rounded-full" style="background:#18181e; border:1px solid #ffffff0d">
              <div class="w-1.5 h-1.5 rounded-full" style="background:#00e5a0"></div>
              <span class="text-[11px] font-mono" style="color:#4a4a5e">{msg.text}</span>
            </div>
          </div>

        {:else if msg.type === 'ai'}
          <div class="msg flex gap-3 max-w-3xl">
            <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style="background:#00e5a014; border:1px solid #00e5a026">
              <svg class="w-3.5 h-3.5" style="color:#00e5a0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1.5">
                <span class="text-xs font-semibold" style="color:#00e5a0">Surfacer</span>
                <span class="text-[10px] font-mono" style="color:#4a4a5e">{msg.timestamp} · 1 credit used</span>
              </div>
              <div class="ai-content text-sm leading-relaxed" style="color:rgba(255,255,255,0.8)">
                {@html simpleMarkdown(msg.content)}{#if msg.streaming}<span class="typing-cursor"></span>{/if}
              </div>
              {#if !msg.streaming}
                <div class="flex items-center gap-2 mt-2.5">
                  {#each [
                    { label: 'Copy',  path: 'M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z' },
                    { label: 'CSV',   path: 'M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
                    { label: 'Share', path: 'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z' },
                  ] as action (action)}
                    <button class="action-btn flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono transition-all" style="color:#4a4a5e; border:1px solid transparent">
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d={action.path}/>
                      </svg>
                      {action.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>

        {:else if msg.type === 'user'}
          <div class="msg flex gap-3 max-w-3xl ml-auto flex-row-reverse">
            <div class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5" style="background:#00e5a0; color:#09090d">Z</div>
            <div class="flex-1 min-w-0 flex flex-col items-end">
              <div class="flex items-center gap-2 mb-1.5">
                <span class="text-[10px] font-mono" style="color:#4a4a5e">{msg.timestamp}</span>
                <span class="text-xs font-semibold" style="color:rgba(255,255,255,0.7)">You</span>
              </div>
              <div class="rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed max-w-sm" style="background:#18181e; border:1px solid #ffffff0d; color:rgba(255,255,255,0.8)">
                {msg.content}
              </div>
            </div>
          </div>
        {/if}
      {/each}

      <!-- Thinking indicator -->
      {#if isThinking}
        <div class="flex gap-3 max-w-3xl">
          <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style="background:#00e5a014; border:1px solid #00e5a026">
            <svg class="w-3.5 h-3.5" style="color:#00e5a0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
          </div>
          <div class="flex items-center gap-1.5 px-4 py-3 rounded-2xl rounded-tl-sm" style="background:#111116; border:1px solid #ffffff0d">
            <div class="dot"></div>
            <div class="dot" style="animation-delay:0.2s"></div>
            <div class="dot" style="animation-delay:0.4s"></div>
          </div>
        </div>
      {/if}
    </div>

    <!-- Chips (empty - will be populated with project templates) -->

    <!-- Input -->
    <div class="shrink-0 px-6 pb-5">
      <div class="input-box flex items-end gap-3 px-4 py-3 rounded-2xl transition-all" style="background:#111116; border:1px solid #ffffff0d">
        <button title="Attach file" class="shrink-0 p-1.5 rounded-lg transition-all mb-0.5" style="color:#4a4a5e">
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
          </svg>
        </button>
        <textarea
          bind:this={textareaEl}
          bind:value={promptValue}
          rows={1}
          placeholder="Ask anything about your Document"
          class="flex-1 bg-transparent outline-none border-none text-sm font-mono text-white placeholder-muted leading-relaxed py-0.5 focus:ring-0"
          style="resize:none; field-sizing:content; max-height:160px; color:white; caret-color:#00e5a0"
          onkeydown={handleKey}
          oninput={(e) => autoResize(e.currentTarget as HTMLTextAreaElement)}
        ></textarea>
        <button
          onclick={sendMessage}
          title="Send message"
          disabled={isThinking || !promptValue.trim()}
          class="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all mb-0.5 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          style="background:#00e5a0; color:#09090d"
        >
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </button>
      </div>
      <p class="text-[10px] font-mono text-center mt-2" style="color:#4a4a5e">
        <kbd class="px-1.5 py-0.5 rounded text-[9px]" style="background:#18181e; border:1px solid #ffffff0d">⌘</kbd> +
        <kbd class="px-1.5 py-0.5 rounded text-[9px]" style="background:#18181e; border:1px solid #ffffff0d">↵</kbd> to send ·
        <kbd class="px-1.5 py-0.5 rounded text-[9px]" style="background:#18181e; border:1px solid #ffffff0d">↵</kbd> for new line
      </p>
    </div>
  </main>
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap');

  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; font-family: 'Syne', sans-serif; background: #09090d; }
  :global(.font-mono) { font-family: 'JetBrains Mono', monospace; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #2a2a38; border-radius: 4px; }

  /* Grain overlay */
  .grain::after {
    content: '';
    position: fixed;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 999;
    opacity: 0.4;
  }

  /* Typing cursor */
  :global(.typing-cursor) {
    display: inline-block;
    width: 2px;
    height: 0.9em;
    background: #00e5a0;
    margin-left: 1px;
    vertical-align: middle;
    animation: blink 1s step-end infinite;
  }

  /* Thinking dots */
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #00e5a0;
    display: inline-block;
    animation: pulseDot 1.4s ease-in-out infinite;
  }

  /* Message animation */
  .msg {
    animation: fadeUp 0.25s ease forwards;
  }

  /* AI content markdown */
  :global(.ai-content p) { margin-bottom: 0.5rem; }
  :global(.ai-content ul) { list-style: disc; padding-left: 1.25rem; margin-bottom: 0.5rem; }
  :global(.ai-content li) { margin-bottom: 0.2rem; }
  :global(.ai-content strong) { color: #e8e8f4; }
  :global(.ai-content code) { background: #1e1e28; padding: 1px 6px; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.8em; }
  :global(.ai-content table) { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.82em; }
  :global(.ai-content th) { background: #1a1a24; padding: 6px 12px; text-align: left; border: 1px solid #ffffff10; color: #00e5a0; font-size: 0.8em; letter-spacing: 0.05em; text-transform: uppercase; }
  :global(.ai-content td) { padding: 6px 12px; border: 1px solid #ffffff08; color: #c0c0d0; }
  :global(.ai-content tr:hover td) { background: #ffffff04; }

  /* Hover states via CSS since Svelte inline handlers are verbose */
  .model-select {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%234a4a5e'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%2F%3E%3C%2Fsvg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 12px;
  }
  .upload-btn:hover { border-color: #00e5a026 !important; color: #00e5a0 !important; background: #00e5a014 !important; }
  .template-btn:hover span { color: white; }
  .template-btn:hover { background: #18181e; border-color: #ffffff16 !important; }
  .chip:hover { border-color: #00e5a026 !important; color: #00e5a0 !important; background: #00e5a014 !important; }
  .action-btn:hover { color: white !important; background: #18181e !important; border-color: #ffffff0d !important; }
  .input-box:focus-within { border-color: #ffffff16 !important; }

  @keyframes fadeUp {
    0%   { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0; }
  }
  @keyframes pulseDot {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
    40%           { transform: scale(1); opacity: 1; }
  }
</style>
