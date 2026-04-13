<script lang="ts">
  import { tick } from 'svelte';
  import katex from 'katex';
  import { authStore } from '$lib/authStore';
  import { supabase } from '$lib/supabaseClient';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  // ── State ──────────────────────────────────────────────────────────────────
  let sidebarOpen = $state(true);
  let isMobile = $state(false);
  let activeFilePath = $state<string | null>(null);
  let activeFileName = $state<string | null>(null);
  let promptValue = $state('');
  let searchQuery = $state('');
  let isThinking = $state(false);
  let isLoadingChat = $state(false);
  let isUploading = $state(false);
  let selectedModel = $state('nvidia/nemotron-3-super-120b-a12b:free');
  let reasoningVisibility = $state<'hide' | 'show'>('hide');
  let messages = $state<Message[]>([]);
  let currentUser = $state<{ id: string; email: string } | null>(null);
  let credits = $state(0);
  let activeChatId = $state<string | null>(null);
  
  let messagesEl: HTMLElement;
  let textareaEl: HTMLTextAreaElement;
  let fileInputEl: HTMLInputElement;

  const modelOptions = [{ label: 'Nemotron 3 Super (Free)', value: 'nvidia/nemotron-3-super-120b-a12b:free' }];

  type Message =
    | { id: string; type: 'system'; text: string }
    | { id: string; type: 'ai'; content: string; reasoning?: string; timestamp: string; streaming?: boolean }
    | { id: string; type: 'user'; content: string; timestamp: string };

  type StoredFile = {
    path: string;
    name: string;
    ext: string;
    sizeLabel: string;
    color: string;
  };

  // ── Files data ─────────────────────────────────────────────────────────────
  let files = $state<StoredFile[]>([]);
  let templates = $state<string[]>([]);

  // ── Init ────────────────────────────────────────────────────────────────────
  onMount(() => {
    const viewport = window.matchMedia('(max-width: 1023px)');
    const syncViewport = () => {
      isMobile = viewport.matches;
      if (isMobile) {
        sidebarOpen = false;
      }
    };

    syncViewport();
    viewport.addEventListener('change', syncViewport);

    const init = async () => {
      const user = await authStore.checkUser();
      if (user) {
        currentUser = {
          id: user.id,
          email: user.email || '',
        };
        try {
          const profile = await authStore.bootstrapCredits();
          credits = profile.credits;
        } catch (err: unknown) {
          console.error('Failed to load credits:', err);
        }
        await loadFiles();
      } else {
        goto('/auth');
      }
    };

    void init();

    return () => {
      viewport.removeEventListener('change', syncViewport);
    };
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function escapeHtml(text: string) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function makeMessageId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function isNearBottom(threshold = 96) {
    if (!messagesEl) return true;
    const distance = messagesEl.scrollHeight - (messagesEl.scrollTop + messagesEl.clientHeight);
    return distance <= threshold;
  }

  function renderMathInline(expression: string) {
    try {
      return katex.renderToString(expression, { throwOnError: false, displayMode: false });
    } catch {
      return `<span class="math-inline">${escapeHtml(expression)}</span>`;
    }
  }

  function renderMathBlock(expression: string) {
    try {
      return `<div class="math-block">${katex.renderToString(expression, { throwOnError: false, displayMode: true })}</div>`;
    } catch {
      return `<div class="math-block">${escapeHtml(expression)}</div>`;
    }
  }

  function formatInline(text: string) {
    const tokens: string[] = [];
    const withMathTokens = text.replace(/\$([^$\n]+)\$/g, (_, expr: string) => {
      const token = `MATH_INLINE_TOKEN_${tokens.length}`;
      tokens.push(renderMathInline(expr.trim()));
      return token;
    });

    let output = escapeHtml(withMathTokens)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');

    tokens.forEach((html, index) => {
      output = output.replace(`MATH_INLINE_TOKEN_${index}`, html);
    });

    return output;
  }

  function isTableSeparator(line: string) {
    return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
  }

  function splitTableRow(line: string) {
    return line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
  }

  function renderTable(headerLine: string, rowLines: string[]) {
    const headers = splitTableRow(headerLine);
    const rows = rowLines.map((line) => splitTableRow(line));

    return `
      <table>
        <thead>
          <tr>${headers.map((header) => `<th>${formatInline(header)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) =>
                `<tr>${headers
                  .map((_, index) => `<td>${formatInline(row[index] || '')}</td>`)
                  .join('')}</tr>`
            )
            .join('')}
        </tbody>
      </table>
    `.trim();
  }

  function renderMarkdown(text: string, streaming = false) {

    const lines = text.replace(/\r/g, '').split('\n');
    const blocks: string[] = [];
    let paragraph: string[] = [];
    let listType: 'ul' | 'ol' | null = null;
    let listItems: string[] = [];
    let codeLines: string[] = [];
    let mathLines: string[] = [];
    let inCode = false;
    let inMath = false;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${paragraph.map(formatInline).join('<br>')}</p>`);
      paragraph = [];
    };

    const flushList = () => {
      if (!listType || !listItems.length) return;
      blocks.push(`<${listType}>${listItems.join('')}</${listType}>`);
      listType = null;
      listItems = [];
    };

    const flushCode = () => {
      if (!codeLines.length) return;
      blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      codeLines = [];
    };

    const flushMath = () => {
      if (!mathLines.length) return;
      blocks.push(renderMathBlock(mathLines.join('\n').trim()));
      mathLines = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (inCode) {
        if (trimmed.startsWith('```')) {
          inCode = false;
          flushCode();
        } else {
          codeLines.push(rawLine);
        }
        continue;
      }

      if (inMath) {
        if (trimmed === '\\]' || trimmed === '$$') {
          inMath = false;
          flushMath();
        } else {
          mathLines.push(rawLine);
        }
        continue;
      }

      if (!trimmed) {
        flushParagraph();
        flushList();
        continue;
      }

      if (trimmed.startsWith('```')) {
        flushParagraph();
        flushList();
        inCode = true;
        continue;
      }

      if (trimmed === '\\[' || trimmed === '$$') {
        flushParagraph();
        flushList();
        inMath = true;
        continue;
      }

      const nextLine = lines[index + 1]?.trim() || '';
      if (trimmed.includes('|') && isTableSeparator(nextLine)) {
        flushParagraph();
        flushList();
        const tableRows: string[] = [];
        let rowIndex = index + 2;

        while (rowIndex < lines.length) {
          const rowLine = lines[rowIndex].trim();
          if (!rowLine || !rowLine.includes('|')) break;
          tableRows.push(lines[rowIndex]);
          rowIndex += 1;
        }

        blocks.push(renderTable(rawLine, tableRows));
        index = rowIndex - 1;
        continue;
      }

      if (/^#{1,3}\s+/.test(trimmed)) {
        flushParagraph();
        flushList();
        const level = trimmed.match(/^#{1,3}/)?.[0].length ?? 1;
        blocks.push(`<h${level}>${formatInline(trimmed.replace(/^#{1,3}\s+/, ''))}</h${level}>`);
        continue;
      }

      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch) {
        flushParagraph();
        if (listType !== 'ul') {
          flushList();
          listType = 'ul';
        }
        listItems.push(`<li>${formatInline(bulletMatch[1])}</li>`);
        continue;
      }

      const numberMatch = trimmed.match(/^\d+\.\s+(.+)/);
      if (numberMatch) {
        flushParagraph();
        if (listType !== 'ol') {
          flushList();
          listType = 'ol';
        }
        listItems.push(`<li>${formatInline(numberMatch[1])}</li>`);
        continue;
      }

      if (/^[A-Z][A-Za-z0-9 ,()\-]{2,}$/.test(trimmed) && trimmed.length <= 48) {
        flushParagraph();
        flushList();
        blocks.push(`<h3>${formatInline(trimmed)}</h3>`);
        continue;
      }

      paragraph.push(rawLine);
    }

    flushParagraph();
    flushList();
    flushCode();
    flushMath();

    return blocks.join('');
  }

  function scrollToBottom() {
    tick().then(() => {
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function formatTimestamp(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'just now';

    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function extensionColor(ext: string) {
    if (ext === 'pdf') return 'text-red-400';
    if (ext === 'csv' || ext === 'xlsx') return 'text-emerald-400';
    if (ext === 'json' || ext === 'xml') return 'text-yellow-400';
    return 'text-cyan-400';
  }

  function formatSize(size: number) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function getAccessToken() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token || null;
  }

  async function loadChatHistory(filePath: string, fileName: string) {
    const token = await getAccessToken();
    if (!token) throw new Error('Session expired');

    const response = await fetch(`/api/chat/history?filePath=${encodeURIComponent(filePath)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load chat history');
    }

    activeChatId = payload.chatId || null;
    const history = Array.isArray(payload.messages) ? payload.messages : [];
    messages = history.length
      ? history.map((entry: { id?: string; role: string; content: string; created_at: string }) => {
          if (entry.role === 'assistant') {
            return {
              id: entry.id || makeMessageId('ai'),
              type: 'ai' as const,
              content: entry.content,
              reasoning: '',
              timestamp: formatTimestamp(entry.created_at),
              streaming: false,
            };
          }

          if (entry.role === 'user') {
            return {
              id: entry.id || makeMessageId('user'),
              type: 'user' as const,
              content: entry.content,
              timestamp: formatTimestamp(entry.created_at),
            };
          }

          return {
            id: entry.id || makeMessageId('system'),
            type: 'system' as const,
            text: entry.content,
          };
        })
      : [{ id: makeMessageId('system'), type: 'system', text: `Ready to chat with ${fileName}` }];
  }

  async function selectFile(file: StoredFile) {
    activeFilePath = file.path;
    activeFileName = file.name;
    isLoadingChat = true;
    try {
      await loadChatHistory(file.path, file.name);
      if (isMobile) {
        sidebarOpen = false;
      }
      scrollToBottom();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load chat history';
      messages = [{ id: makeMessageId('system'), type: 'system', text: message }];
      activeChatId = null;
    } finally {
      isLoadingChat = false;
    }
  }

  async function loadFiles() {
    const token = await getAccessToken();
    if (!token) return;

    const response = await fetch('/api/files/list', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to load files');
    }

    files = payload.files.map((file: { path: string; name: string; size: number }) => {
      const displayName = file.name.replace(/^\d+-/, '');
      const ext = displayName.split('.').pop()?.toLowerCase() || 'file';
      return {
        path: file.path,
        name: displayName,
        ext,
        sizeLabel: formatSize(file.size || 0),
        color: extensionColor(ext),
      };
    });
  }

  function openUploadPicker() {
    fileInputEl?.click();
  }

  async function handleFilePick(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (!file || isUploading) return;

    isUploading = true;
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Session expired');

      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Upload failed');
      }

      await loadFiles();
      const uploaded = files.find((entry) => entry.path === payload.file.path);
      if (uploaded) {
        await selectFile(uploaded);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: message }];
    } finally {
      isUploading = false;
      target.value = '';
    }
  }

  async function deleteFile(file: StoredFile) {
    const confirmDelete = window.confirm(`Delete ${file.name}?`);
    if (!confirmDelete) return;

    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Session expired');

      const response = await fetch('/api/files/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ filePath: file.path }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Delete failed');
      }

      files = files.filter((entry) => entry.path !== file.path);
      if (activeFilePath === file.path) {
        activeFilePath = null;
        activeFileName = null;
        activeChatId = null;
        messages = [];
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: message }];
    }
  }

  async function sendMessage() {
    const text = promptValue.trim();
    if (!text || isThinking || isLoadingChat) return;
    if (!activeFilePath) {
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: 'Upload and select a file first.' }];
      return;
    }

    promptValue = '';
    if (textareaEl) { textareaEl.style.height = 'auto'; }

    const now = formatTimestamp(new Date().toISOString());
    messages = [...messages, { id: makeMessageId('user'), type: 'user', content: text, timestamp: now }];
    const aiIndex = messages.length;
    messages = [...messages, { id: makeMessageId('ai'), type: 'ai', content: '', reasoning: '', timestamp: now, streaming: true }];
    isThinking = true;
    scrollToBottom();

    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Session expired');

      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: text,
          filePath: activeFilePath,
          chatId: activeChatId,
          model: selectedModel,
        }),
      });

      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'Chat request failed');
      }

      if (!response.body) {
        throw new Error('No stream received from server');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let content = '';
      let reasoning = '';
      let streamBuffer = '';
      let pendingRender = false;

      const applyAiUpdate = (force = false) => {
        if (!force && pendingRender) return;
        pendingRender = true;

        const render = () => {
          pendingRender = false;
          const wasNearBottom = isNearBottom();
          const next = [...messages];
          const target = next[aiIndex];
          if (target && target.type === 'ai') {
            next[aiIndex] = { ...target, content, reasoning, streaming: true };
            messages = next;
          }
          if (wasNearBottom) {
            scrollToBottom();
          }
        };

        if (force) {
          render();
          return;
        }

        requestAnimationFrame(render);
      };

      const handleEventLine = (line: string) => {
        if (!line.trim()) return;

        try {
          const payload = JSON.parse(line) as { type?: string; delta?: string };
          if (payload.type === 'reasoning' && payload.delta) {
            reasoning += payload.delta;
            applyAiUpdate();
            return;
          }

          if (payload.type === 'content' && payload.delta) {
            content += payload.delta;
            applyAiUpdate();
            return;
          }

          if (payload.type === 'done') {
            return;
          }
        } catch {
          content += line;
          applyAiUpdate();
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });

        let splitAt = streamBuffer.indexOf('\n');
        while (splitAt >= 0) {
          const line = streamBuffer.slice(0, splitAt);
          streamBuffer = streamBuffer.slice(splitAt + 1);
          handleEventLine(line);
          splitAt = streamBuffer.indexOf('\n');
        }
      }

      streamBuffer += decoder.decode();
      if (streamBuffer.trim()) {
        handleEventLine(streamBuffer.trim());
      }

      applyAiUpdate(true);

      const next = [...messages];
      const target = next[aiIndex];
      if (target && target.type === 'ai') {
        next[aiIndex] = { ...target, content, reasoning, streaming: false };
        messages = next;
      }
    } catch (err: unknown) {
      const errorText = err instanceof Error ? err.message : 'Chat failed';
      const next = [...messages];
      const target = next[aiIndex];
      if (target && target.type === 'ai') {
        next[aiIndex] = { ...target, content: errorText, reasoning: '', streaming: false };
        messages = next;
      }
    } finally {
      isThinking = false;
    }
  }

  function visibleFiles() {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return files;
    return files.filter((file) => file.name.toLowerCase().includes(query));
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

</script>

<!-- ════════════════════════════ ROOT ════════════════════════════ -->
<div class="grain app-shell min-h-dvh h-dvh flex overflow-hidden font-sans text-white" style="background:#09090d">

  {#if isMobile && sidebarOpen}
    <button
      class="sidebar-backdrop"
      aria-label="Close sidebar"
      onclick={() => {
        sidebarOpen = false;
      }}
    ></button>
  {/if}

  <!-- ═══ SIDEBAR ═══ -->
  <aside
    class="app-sidebar shrink-0 flex flex-col border-r h-full overflow-hidden transition-all duration-300"
    class:sidebar-open={sidebarOpen}
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
      <input bind:this={fileInputEl} type="file" class="hidden" onchange={handleFilePick} />
      <button onclick={openUploadPicker} disabled={isUploading} class="upload-btn w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed text-xs font-mono tracking-wide transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed" style="border-color:#ffffff16; color:#4a4a5e">
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
        </svg>
        {isUploading ? 'Uploading...' : 'Upload Document'}
      </button>
    </div>

    <!-- Search -->
    <div class="px-4 pb-3">
      <div class="flex items-center gap-2 px-3 py-2 rounded-lg" style="background:#18181e; border:1px solid #ffffff0d">
        <svg class="w-3 h-3 shrink-0" style="color:#4a4a5e" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
        </svg>
        <input bind:value={searchQuery} type="text" placeholder="Search files" class="bg-transparent text-xs font-mono text-white placeholder-muted w-full duration-400 transition-all focus:ring-0" style="color:white" />
      </div>
    </div>

    <!-- Files label -->
    <div class="px-4 mb-2">
      <p class="text-[9px] font-mono tracking-[2px] uppercase" style="color:#4a4a5e">Documents</p>
    </div>

    <!-- File list -->
    <div class="flex-1 overflow-y-auto px-3 flex flex-col gap-1">
      {#each visibleFiles() as file (file.path)}
        <div
          onclick={() => void selectFile(file)}
          role="button"
          tabindex="0"
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              void selectFile(file);
            }
          }}
          class="file-item w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-all cursor-pointer"
          style="border:1px solid {activeFilePath === file.path ? '#00e5a030' : '#ffffff0d'}; background:{activeFilePath === file.path ? '#00e5a010' : 'transparent'}"
        >
          <div class="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style="background:#18181e; border:1px solid #ffffff0d">
            <svg class="w-3.5 h-3.5 {file.color}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-xs font-medium truncate" style="color:{activeFilePath === file.path ? '#00e5a0' : 'rgba(255,255,255,0.8)'}">{file.name}</p>
            <p class="text-[10px] font-mono" style="color:#4a4a5e">{file.ext} · {file.sizeLabel}</p>
          </div>
          <button
            onclick={(event) => {
              event.stopPropagation();
              deleteFile(file);
            }}
            title="Delete file"
            class="ml-2 shrink-0 p-1.5 rounded-md transition-colors"
            style="color:#4a4a5e"
            onmouseenter={e => (e.currentTarget as HTMLElement).style.color = '#ff8787'}
            onmouseleave={e => (e.currentTarget as HTMLElement).style.color = '#4a4a5e'}
          >
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </button>
        </div>
      {/each}

      {#if visibleFiles().length === 0}
        <div class="px-3 py-6 text-[11px] font-mono text-center" style="color:#4a4a5e">
          No uploaded files yet
        </div>
      {/if}

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
          <span class="text-[10px] font-mono font-medium" style="color:#00e5a0">{credits}</span>
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
            title="Logout"
            onclick={handleLogout}
            class="ml-auto p-1 transition-colors rounded"
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
  <main class="app-main flex-1 flex flex-col h-full min-w-0" style="background:#09090d">

    <!-- Header -->
    <header class="app-header shrink-0 flex items-center justify-between px-6 py-3.5 backdrop-blur-sm" style="border-bottom:1px solid #ffffff0d; background:rgba(17,17,22,0.6)">
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
          <span class="text-xs font-mono" style="color:rgba(255,255,255,0.8)">{activeFileName || 'No file selected'}</span>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2">
          <select
            bind:value={selectedModel}
            class="model-select desktop-only px-3 py-1.5 rounded-lg text-xs font-mono"
            style="background:#18181e; border:1px solid #ffffff0d; color:#c9c9d9"
          >
            {#each modelOptions as model (model.value)}
              <option value={model.value}>{model.label}</option>
            {/each}
          </select>

          <select
            bind:value={reasoningVisibility}
            class="model-select desktop-only px-3 py-1.5 rounded-lg text-xs font-mono"
            style="background:#18181e; border:1px solid #ffffff0d; color:#c9c9d9"
          >
            <option value="hide">Reasoning: hidden</option>
            <option value="show">Reasoning: shown</option>
          </select>
        </div>
        {#each [
          { title: 'Share', path: 'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z' },
          { title: 'Download', path: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4' },
        ] as btn (btn)}
          <button title={btn.title} class="desktop-only p-2 rounded-lg transition-all" style="color:#4a4a5e">
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
    <div bind:this={messagesEl} class="messages-wrap flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-5">
      {#each messages as msg (msg.id)}
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
              {#if msg.reasoning?.trim()}
                <details class="ai-reasoning-box mb-2" open={reasoningVisibility === 'show'}>
                  <summary class="ai-reasoning-summary">Reasoning trace</summary>
                  <div class="ai-reasoning text-xs leading-relaxed mt-1.5">
                    {@html renderMarkdown(msg.reasoning || '')}
                  </div>
                </details>
              {/if}
              <div class="ai-content text-sm leading-relaxed" style="color:rgba(255,255,255,0.8)">
                {@html renderMarkdown(msg.content)}{#if msg.streaming}<span class="typing-cursor"></span>{/if}
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
              <div class="user-bubble rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed max-w-sm" style="background:#18181e; border:1px solid #ffffff0d; color:rgba(255,255,255,0.8)">
                {msg.content}
              </div>
            </div>
          </div>
        {/if}
      {/each}

    </div>

    <!-- Chips (empty - will be populated with project templates) -->

    <!-- Input -->
    <div class="input-wrap shrink-0 px-6 pb-5">
      <div class="input-box flex items-end gap-3 px-4 py-3 rounded-2xl transition-all" style="background:#111116; border:1px solid #ffffff0d">
        <button title="Attach file" onclick={openUploadPicker} class="shrink-0 p-1.5 rounded-lg transition-all mb-0.5" style="color:#4a4a5e">
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
          disabled={isThinking || isLoadingChat || !promptValue.trim()}
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
  @import 'katex/dist/katex.min.css';

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

  .ai-reasoning-box {
    border: 1px solid #ffffff12;
    border-radius: 10px;
    background: #101018;
    padding: 0.5rem 0.65rem;
  }

  .ai-reasoning-summary {
    cursor: pointer;
    color: #8f92a8;
    font-size: 0.7rem;
    font-family: 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    user-select: none;
  }

  .ai-reasoning {
    color: #a5a9c3;
  }

  /* Message animation */
  .msg {
    animation: fadeUp 0.25s ease forwards;
  }

  /* AI content markdown */
  :global(.ai-content h1) { margin: 0.15rem 0 0.55rem; font-size: 1.15rem; line-height: 1.25; color: #ffffff; }
  :global(.ai-content h2) { margin: 0.15rem 0 0.5rem; font-size: 1.05rem; line-height: 1.3; color: #ffffff; }
  :global(.ai-content h3) { margin: 0.15rem 0 0.45rem; font-size: 0.98rem; line-height: 1.3; color: #ffffff; }
  :global(.ai-content p) { margin-bottom: 0.5rem; }
  :global(.ai-content ul) { list-style: disc; padding-left: 1.25rem; margin-bottom: 0.5rem; }
  :global(.ai-content ol) { list-style: decimal; padding-left: 1.25rem; margin-bottom: 0.5rem; }
  :global(.ai-content li) { margin-bottom: 0.2rem; }
  :global(.ai-content strong) { color: #e8e8f4; }
  :global(.ai-content code) { background: #1e1e28; padding: 1px 6px; border-radius: 4px; font-family: 'JetBrains Mono', monospace; font-size: 0.8em; }
  :global(.ai-content pre) { background: #14141c; border: 1px solid #ffffff10; border-radius: 12px; padding: 0.85rem 1rem; overflow-x: auto; margin: 0.75rem 0; }
  :global(.ai-content pre code) { background: transparent; padding: 0; border-radius: 0; font-size: 0.82em; color: #d7d7e8; }
  :global(.ai-content .math-block) { background: #14141c; border: 1px solid #ffffff10; border-radius: 12px; padding: 0.85rem 1rem; margin: 0.75rem 0; color: #a7f3d0; font-family: 'JetBrains Mono', monospace; overflow-x: auto; }
  :global(.ai-content .math-inline) { color: #a7f3d0; font-family: 'JetBrains Mono', monospace; font-size: 0.92em; }
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

  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    border: none;
    z-index: 35;
  }

  @media (max-width: 1023px) {
    .app-shell {
      min-height: 100dvh;
      height: 100dvh;
      position: relative;
    }

    .app-sidebar {
      position: fixed;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 40;
      width: min(84vw, 320px) !important;
      max-width: 320px;
      transform: translateX(-105%);
      opacity: 1 !important;
      pointer-events: none;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
    }

    .app-sidebar.sidebar-open {
      transform: translateX(0);
      pointer-events: auto;
    }

    .app-main {
      width: 100%;
      min-width: 0;
    }

    .app-header {
      padding: 0.7rem 0.9rem;
      gap: 0.55rem;
    }

    .messages-wrap {
      padding: 0.9rem 0.8rem;
      gap: 0.9rem;
    }

    .msg {
      max-width: 100%;
    }

    .user-bubble {
      max-width: min(88vw, 34rem);
    }

    .input-wrap {
      padding: 0 0.8rem 0.75rem;
    }

    .input-box {
      border-radius: 1rem;
      padding: 0.55rem 0.65rem;
      gap: 0.55rem;
    }
  }

  @media (max-width: 640px) {
    .desktop-only {
      display: none !important;
    }

    :global(.ai-content table) {
      display: block;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      white-space: nowrap;
    }

    :global(.ai-content pre),
    :global(.ai-content .math-block) {
      padding: 0.7rem 0.75rem;
    }
  }

  @keyframes fadeUp {
    0%   { opacity: 0; transform: translateY(8px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0; }
  }
</style>
