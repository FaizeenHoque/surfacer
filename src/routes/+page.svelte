<script lang="ts">
  import { tick } from 'svelte';
  import katex from 'katex';
  import { authStore, type ActiveSubscriptionStatus, type CreditPackOption } from '$lib/authStore';
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
  let isCreatingCheckout = $state(false);
  let isCancellingSubscription = $state(false);
  let isBillingModalOpen = $state(false);
  let selectedModel = $state('microsoft/Phi-4');
  let reasoningVisibility = $state<'hide' | 'show'>('hide');
  let messages = $state<Message[]>([]);
  let currentUser = $state<{ id: string; email: string } | null>(null);
  let credits = $state(0);
  let creditPacks = $state<CreditPackOption[]>([]);
  let selectedPackId = $state<string>('');
  let activeSubscription = $state<ActiveSubscriptionStatus | null>(null);
  let activeChatId = $state<string | null>(null);
  
  let messagesEl: HTMLElement;
  let textareaEl: HTMLTextAreaElement;
  let fileInputEl: HTMLInputElement;

  const modelOptions = [
    { label: 'Basic', value: 'microsoft/Phi-4' },
    { label: 'Premium', value: 'deepseek/DeepSeek-V3-0324' },
  ];

  type Message =
    | { id: string; type: 'system'; text: string }
    | { id: string; type: 'ai'; content: string; reasoning?: string; timestamp: string; streaming?: boolean; creditsUsed?: number; suggestedQuestions?: string[]; followUpsLoading?: boolean }
    | { id: string; type: 'user'; content: string; timestamp: string };

  type StoredFile = {
    path: string;
    name: string;
    ext: string;
    sizeLabel: string;
    color: string;
  };

  type ExtractionHistoryItem = {
    id: string;
    chat_id: string | null;
    file_path: string;
    file_name: string;
    prompt: string;
    result: string;
    created_at: string;
  };

  type ExtractionTemplate = {
    id: string;
    name: string;
    fields_csv: string;
    created_at: string;
  };

  // ── Files data ─────────────────────────────────────────────────────────────
  let files = $state<StoredFile[]>([]);
  let templates = $state<ExtractionTemplate[]>([]);
  let templateName = $state('');
  let templateFieldsCsv = $state('');
  let isLoadingTemplates = $state(false);
  let isCreatingTemplate = $state(false);
  let deletingTemplateId = $state<string | null>(null);
  let templateError = $state<string | null>(null);
  let extractionHistory = $state<ExtractionHistoryItem[]>([]);
  let extractionQuery = $state('');
  let isLoadingExtractions = $state(false);
  let extractionError = $state<string | null>(null);
  let extractionSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let notificationToast = $state<{ id: number; text: string; visible: boolean } | null>(null);
  let toastHideTimer: ReturnType<typeof setTimeout> | null = null;
  let toastRemoveTimer: ReturnType<typeof setTimeout> | null = null;
  let exportMenuForId = $state<string | null>(null);
  let shareDialogOpen = $state(false);
  let shareDialogLoading = $state(false);
  let shareDialogError = $state<string | null>(null);
  let shareDialogUrl = $state<string | null>(null);
  let isSettingsWindowOpen = $state(false);

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

    const initialUrl = new URL(window.location.href);
    const initialBillingStatus = initialUrl.searchParams.get('billing');

    const scrubBillingUrl = () => {
      const url = new URL(window.location.href);
      const keysToRemove = [
        'billing',
        'subscription_id',
        'status',
        'email',
        'customer_id',
        'payment_id',
        'session_id',
        'checkout_id',
      ];

      let changed = false;
      for (const key of keysToRemove) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      }

      if (changed) {
        window.history.replaceState({}, '', url.pathname + url.search);
      }
    };

    scrubBillingUrl();

    const init = async () => {
      const user = await authStore.checkUser();
      if (user) {
        currentUser = {
          id: user.id,
          email: user.email || '',
        };
        await refreshCredits();
        await loadCreditPacks();
        await refreshSubscriptionStatus();

        if (initialBillingStatus === 'success') {
          const creditsBefore = credits;
          let creditsAfter = creditsBefore;
          for (let attempt = 0; attempt < 6; attempt += 1) {
            await refreshCredits();
            creditsAfter = credits;
            if (creditsAfter > creditsBefore) break;
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }

          messages = [
            ...messages,
            {
              id: makeMessageId('system'),
              type: 'system',
              text:
                creditsAfter > creditsBefore
                  ? 'Payment successful. Credits updated.'
                  : 'Payment succeeded. Credits may take a few seconds to sync from webhook.',
            },
          ];
          await refreshSubscriptionStatus();
        }

        if (initialBillingStatus === 'cancelled') {
          messages = [...messages, { id: makeMessageId('system'), type: 'system', text: 'Payment was cancelled.' }];
        }

        if (initialBillingStatus === 'portal') {
          messages = [...messages, { id: makeMessageId('system'), type: 'system', text: 'Returned from billing portal.' }];
        }

        await loadFiles();
        await loadTemplates();
        await loadExtractionHistory();
      } else {
        goto('/auth');
      }
    };

    void init();

    return () => {
      viewport.removeEventListener('change', syncViewport);
      if (extractionSearchTimer) {
        clearTimeout(extractionSearchTimer);
      }
      if (toastHideTimer) {
        clearTimeout(toastHideTimer);
      }
      if (toastRemoveTimer) {
        clearTimeout(toastRemoveTimer);
      }
    };
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function refreshCredits() {
    try {
      const profile = await authStore.bootstrapCredits();
      credits = profile.credits;
    } catch (err: unknown) {
      console.error('Failed to load credits:', err);
    }
  }

  function formatPrice(pack: CreditPackOption) {
    if (!pack.priceCents || !pack.currency) return 'Price shown at checkout';
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: pack.currency,
      }).format(pack.priceCents / 100);
    } catch {
      return `${(pack.priceCents / 100).toFixed(2)} ${pack.currency}`;
    }
  }

  function formatInterval(pack: CreditPackOption) {
    if (pack.interval === 'month') return '/month';
    if (pack.interval === 'year') return '/year';
    return '';
  }

  function formatCredits(value: number) {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2).replace(/\.00$/, '');
  }

  function selectedPack() {
    return creditPacks.find((pack) => pack.id === selectedPackId) || null;
  }

  async function loadCreditPacks() {
    try {
      const packs = await authStore.getCreditPacks();
      creditPacks = packs.filter((pack) => pack.credits > 0);
      if (!selectedPackId && creditPacks.length > 0) {
        selectedPackId = creditPacks[0].id;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load credit packs';
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: message }];
      creditPacks = [];
      selectedPackId = '';
    }
  }

  async function refreshSubscriptionStatus() {
    try {
      const payload = await authStore.getActiveSubscriptionStatus();
      activeSubscription = payload.hasActiveSubscription ? payload.subscription : null;
    } catch (err: unknown) {
      console.error('Failed to load subscription status:', err);
    }
  }

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
    const withDollarMathTokens = text.replace(/\$([^$\n]+)\$/g, (_, expr: string) => {
      const token = `MATH_INLINE_TOKEN_${tokens.length}`;
      tokens.push(renderMathInline(expr.trim()));
      return token;
    });

    const withMathTokens = withDollarMathTokens.replace(/\\\((.+?)\\\)/g, (_, expr: string) => {
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

  function renderMarkdown(text: string) {

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

  function safeFileStem(value: string) {
    const stem = value.trim().replace(/\.[a-z0-9]+$/i, '');
    return (stem || 'chat_export').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 42);
  }

  function parseMarkdownTableRows(text: string) {
    const lines = text.replace(/\r/g, '').split('\n');
    for (let index = 0; index < lines.length - 1; index += 1) {
      const header = lines[index].trim();
      const separator = lines[index + 1].trim();
      const looksLikeTable = header.includes('|') && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separator);
      if (!looksLikeTable) continue;

      const split = (line: string) =>
        line
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());

      const headers = split(header).map((entry, i) => entry || `column_${i + 1}`);
      const rows: Record<string, string>[] = [];

      let rowIndex = index + 2;
      while (rowIndex < lines.length) {
        const row = lines[rowIndex].trim();
        if (!row || !row.includes('|')) break;
        const cells = split(row);
        const next: Record<string, string> = {};
        headers.forEach((key, i) => {
          next[key] = cells[i] || '';
        });
        rows.push(next);
        rowIndex += 1;
      }

      if (rows.length) return rows;
    }

    return [] as Record<string, string>[];
  }

  function parseKeyValueRows(text: string) {
    const map: Record<string, string> = {};
    const lines = text.replace(/\r/g, '').split('\n');
    for (const line of lines) {
      const cleaned = line.replace(/^[-*]\s*/, '').trim();
      const match = cleaned.match(/^([^:]{1,80}):\s+(.+)$/);
      if (!match) continue;
      map[match[1].trim()] = match[2].trim();
    }
    return Object.keys(map).length ? [map] : [];
  }

  function parseJsonRows(text: string) {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    if (!cleaned) return [] as Record<string, unknown>[];

    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'object' && entry !== null)) {
        return parsed as Record<string, unknown>[];
      }
      if (parsed && typeof parsed === 'object') {
        return [parsed as Record<string, unknown>];
      }
    } catch {
      return [];
    }

    return [] as Record<string, unknown>[];
  }

  function normalizeStructuredRows(text: string) {
    const fromJson = parseJsonRows(text);
    if (fromJson.length) {
      return fromJson.map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? '' : String(value)]))
      );
    }

    const fromTable = parseMarkdownTableRows(text);
    if (fromTable.length) return fromTable;

    const fromKv = parseKeyValueRows(text);
    if (fromKv.length) return fromKv;

    return [{ response: text.replace(/\s+/g, ' ').trim() }];
  }

  function csvEscape(value: string) {
    if (/[",\n]/.test(value)) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  function rowsToCsv(rows: Record<string, string>[]) {
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const lines = [headers.map(csvEscape).join(',')];

    for (const row of rows) {
      lines.push(headers.map((header) => csvEscape(row[header] || '')).join(','));
    }

    return lines.join('\n');
  }

  function downloadBlob(fileName: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function notifySystem(text: string) {
    const id = Date.now();
    notificationToast = { id, text, visible: true };

    if (toastHideTimer) clearTimeout(toastHideTimer);
    if (toastRemoveTimer) clearTimeout(toastRemoveTimer);

    toastHideTimer = setTimeout(() => {
      if (!notificationToast || notificationToast.id !== id) return;
      notificationToast = { ...notificationToast, visible: false };
      toastRemoveTimer = setTimeout(() => {
        if (notificationToast?.id === id) {
          notificationToast = null;
        }
      }, 220);
    }, 3400);
  }

  async function copyAssistantMessage(msg: Extract<Message, { type: 'ai' }>) {
    const text = msg.content?.trim() || '';
    if (!text) {
      notifySystem('Nothing to copy yet.');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      notifySystem('Response copied to clipboard.');
    } catch {
      notifySystem('Clipboard permission denied.');
    }
  }

  async function exportAssistantMessage(msg: Extract<Message, { type: 'ai' }>, selected: 'csv' | 'json' | 'xlsx') {
    const text = msg.content?.trim() || '';
    if (!text) {
      notifySystem('No response to export yet.');
      return;
    }

    const rows = normalizeStructuredRows(text);
    const stem = `${safeFileStem(activeFileName || 'chat')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;

    if (selected === 'csv') {
      const csv = rowsToCsv(rows);
      downloadBlob(`${stem}.csv`, new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      notifySystem('CSV export downloaded.');
      return;
    }

    if (selected === 'json') {
      downloadBlob(`${stem}.json`, new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' }));
      notifySystem('JSON export downloaded.');
      return;
    }

    const XLSX = await import('xlsx');
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Extraction');
    const xlsx = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    downloadBlob(`${stem}.xlsx`, new Blob([xlsx], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    notifySystem('Excel export downloaded.');
  }

  async function exportFromMenu(msg: Extract<Message, { type: 'ai' }>, selected: 'csv' | 'json' | 'xlsx') {
    exportMenuForId = null;
    await exportAssistantMessage(msg, selected);
  }

  async function shareCurrentChat() {
    const token = await getAccessToken();
    if (!token) throw new Error('Session expired');

    const response = await fetch('/api/chat/share', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chatId: activeChatId,
        filePath: activeFilePath,
        fileName: activeFileName,
        messages,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to create share link');
    }

    return payload.shareUrl as string;
  }

  async function copyShareLink() {
    if (!shareDialogUrl) return;
    try {
      await navigator.clipboard.writeText(shareDialogUrl);
      notifySystem('Share link copied to clipboard.');
    } catch {
      notifySystem('Clipboard permission denied.');
    }
  }

  function closeShareDialog() {
    shareDialogOpen = false;
    shareDialogLoading = false;
    shareDialogError = null;
    shareDialogUrl = null;
  }

  async function shareChatAction() {
    try {
      if (!messages.length) {
        notifySystem('No chat content available to share yet.');
        return;
      }

      shareDialogOpen = true;
      shareDialogLoading = true;
      shareDialogError = null;
      shareDialogUrl = null;

      const shareUrl = await shareCurrentChat();
      shareDialogUrl = shareUrl;

      try {
        await navigator.clipboard.writeText(shareUrl);
        notifySystem('Share link ready and copied to clipboard.');
      } catch {
        notifySystem('Share link ready.');
      }
    } catch (err: unknown) {
      shareDialogError = err instanceof Error ? err.message : 'Failed to share chat';
      notifySystem(shareDialogError);
    } finally {
      shareDialogLoading = false;
    }
  }

  function shorten(text: string, max = 96) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= max) return normalized;
    return `${normalized.slice(0, max - 1)}...`;
  }

  function formatRelativeTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'recently';
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function buildTemplatePrompt(template: ExtractionTemplate) {
    return `Extract the following values from the selected document: ${template.fields_csv}. Return concise structured output with one item per field.`;
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

  async function loadExtractionHistory(query = extractionQuery) {
    try {
      extractionError = null;
      isLoadingExtractions = true;

      const token = await getAccessToken();
      if (!token) {
        extractionHistory = [];
        return;
      }

      const response = await fetch(`/api/extractions?days=30&query=${encodeURIComponent(query.trim())}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load extraction history');
      }

      extractionHistory = Array.isArray(payload.extractions) ? payload.extractions : [];
    } catch (err: unknown) {
      extractionError = err instanceof Error ? err.message : 'Failed to load extraction history';
      extractionHistory = [];
    } finally {
      isLoadingExtractions = false;
    }
  }

  async function loadTemplates() {
    try {
      templateError = null;
      isLoadingTemplates = true;

      const token = await getAccessToken();
      if (!token) {
        templates = [];
        return;
      }

      const response = await fetch('/api/templates', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load templates');
      }

      templates = Array.isArray(payload.templates) ? payload.templates : [];
    } catch (err: unknown) {
      templateError = err instanceof Error ? err.message : 'Failed to load templates';
      templates = [];
    } finally {
      isLoadingTemplates = false;
    }
  }

  async function createTemplate() {
    if (isCreatingTemplate) return;

    const name = templateName.trim();
    const values = templateFieldsCsv
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (name.length < 2) {
      templateError = 'Template name must be at least 2 characters.';
      return;
    }

    if (!values.length) {
      templateError = 'Add extraction values separated by commas.';
      return;
    }

    try {
      templateError = null;
      isCreatingTemplate = true;

      const token = await getAccessToken();
      if (!token) throw new Error('Session expired');

      const response = await fetch('/api/templates', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name,
          fieldsCsv: values.join(', '),
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to create template');
      }

      if (payload.template) {
        templates = [payload.template, ...templates.filter((entry) => entry.id !== payload.template.id)];
      }

      templateName = '';
      templateFieldsCsv = '';
    } catch (err: unknown) {
      templateError = err instanceof Error ? err.message : 'Failed to create template';
    } finally {
      isCreatingTemplate = false;
    }
  }

  async function deleteTemplate(templateId: string) {
    if (deletingTemplateId) return;

    try {
      deletingTemplateId = templateId;
      templateError = null;

      const token = await getAccessToken();
      if (!token) throw new Error('Session expired');

      const response = await fetch(`/api/templates?id=${encodeURIComponent(templateId)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to delete template');
      }

      templates = templates.filter((entry) => entry.id !== templateId);
    } catch (err: unknown) {
      templateError = err instanceof Error ? err.message : 'Failed to delete template';
    } finally {
      deletingTemplateId = null;
    }
  }

  async function applyTemplate(template: ExtractionTemplate) {
    if (!activeFilePath) {
      messages = [
        ...messages,
        {
          id: makeMessageId('system'),
          type: 'system',
          text: 'Select a document first, then apply the template.',
        },
      ];
      return;
    }

    promptValue = buildTemplatePrompt(template);
    await tick();
    if (textareaEl) {
      autoResize(textareaEl);
      textareaEl.focus();
    }
  }

  function handleExtractionSearchInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    extractionQuery = input.value;

    if (extractionSearchTimer) {
      clearTimeout(extractionSearchTimer);
    }

    extractionSearchTimer = setTimeout(() => {
      void loadExtractionHistory(extractionQuery);
    }, 220);
  }

  async function openExtractionDocument(item: ExtractionHistoryItem, withPrompt: boolean) {
    let target = files.find((file) => file.path === item.file_path);
    if (!target) {
      await loadFiles();
      target = files.find((file) => file.path === item.file_path);
    }

    if (!target) {
      messages = [
        ...messages,
        {
          id: makeMessageId('system'),
          type: 'system',
          text: 'Original document is no longer in your library. Upload it again to rerun this extraction.',
        },
      ];
      return;
    }

    await selectFile(target);
    promptValue = withPrompt ? item.prompt : '';
    await tick();
    if (textareaEl) {
      autoResize(textareaEl);
      textareaEl.focus();
    }
  }

  function openUploadPicker() {
    fileInputEl?.click();
  }

  async function handleFilePick(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (!file || isUploading) return;

    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_FILE_SIZE) {
      notifySystem(`File exceeds 10MB limit. Your file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
      target.value = '';
      return;
    }

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

      notifySystem('File uploaded successfully.');
      await loadFiles();
      const uploaded = files.find((entry) => entry.path === payload.file.path);
      if (uploaded) {
        await selectFile(uploaded);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      notifySystem(message);
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
      extractionHistory = extractionHistory.filter((entry) => entry.file_path !== file.path);
      if (activeFilePath === file.path) {
        activeFilePath = null;
        activeFileName = null;
        activeChatId = null;
        messages = [];
      }

      void loadExtractionHistory();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Delete failed';
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: message }];
    }
  }

  async function sendMessage(options: { followUp?: boolean; text?: string } = {}) {
    const text = (options.text ?? promptValue).trim();
    const followUp = options.followUp === true;
    if (!text || isThinking || isLoadingChat) return;
    if (!activeFilePath) {
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: 'Upload and select a file first.' }];
      return;
    }

    if (!options.text) {
      promptValue = '';
    }
    if (textareaEl) {
      textareaEl.style.height = 'auto';
    }

    const now = formatTimestamp(new Date().toISOString());
    messages = [...messages, { id: makeMessageId('user'), type: 'user', content: text, timestamp: now }];
    const aiIndex = messages.length;
    messages = [...messages, { id: makeMessageId('ai'), type: 'ai', content: '', reasoning: '', timestamp: now, streaming: true, followUpsLoading: false }];
    isThinking = true;
    scrollToBottom();

    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Session expired');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);

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
          followUp,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        const raw = await response.text();
        let message = 'Chat request failed';
        if (raw) {
          try {
            const payload = JSON.parse(raw) as { error?: string; message?: string };
            message = payload.error || payload.message || raw;
          } catch {
            message = raw;
          }
        }
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error('No stream received from server');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let content = '';
      let reasoning = '';
      let streamBuffer = '';
      let eventDataLines: string[] = [];
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

      const handlePayload = (payloadLine: string) => {
        if (!payloadLine || payloadLine === '[DONE]') return;

        try {
          const payload = JSON.parse(payloadLine) as {
            type?: string;
            delta?: string;
            creditsUsed?: number;
            creditsRemaining?: number;
            suggestions?: string[];
            loading?: boolean;
          };
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

          if (payload.type === 'usage' && typeof payload.creditsRemaining === 'number') {
            credits = Math.max(0, payload.creditsRemaining);

            if (typeof payload.creditsUsed === 'number') {
              const next = [...messages];
              const target = next[aiIndex];
              if (target && target.type === 'ai') {
                next[aiIndex] = { ...target, creditsUsed: payload.creditsUsed };
                messages = next;
              }
            }

            return;
          }

          if (payload.type === 'followup_suggestions' && Array.isArray(payload.suggestions)) {
            const next = [...messages];
            const target = next[aiIndex];
            if (target && target.type === 'ai') {
              next[aiIndex] = {
                ...target,
                followUpsLoading: false,
                suggestedQuestions: payload.suggestions.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
              };
              messages = next;
            }

            return;
          }

          if (payload.type === 'followup_loading' && typeof payload.loading === 'boolean') {
            const next = [...messages];
            const target = next[aiIndex];
            if (target && target.type === 'ai') {
              next[aiIndex] = {
                ...target,
                followUpsLoading: payload.loading,
              };
              messages = next;
            }

            return;
          }
        } catch {
          content += payloadLine;
          applyAiUpdate();
        }
      };

      const flushSseEvent = () => {
        if (!eventDataLines.length) return;
        const payloadLine = eventDataLines.join('\n').trim();
        eventDataLines = [];
        handlePayload(payloadLine);
      };

      const processSseChunk = (chunk: string) => {
        streamBuffer += chunk;

        while (true) {
          const match = streamBuffer.match(/\r\n|\n|\r/);
          if (!match || match.index === undefined) break;

          const lineEnd = match.index;
          const line = streamBuffer.slice(0, lineEnd);
          streamBuffer = streamBuffer.slice(lineEnd + match[0].length);

          if (!line) {
            flushSseEvent();
            continue;
          }

          if (line.startsWith(':') || line.startsWith('event:')) {
            continue;
          }

          if (line.startsWith('data:')) {
            eventDataLines.push(line.slice(5).trimStart());
          } else {
            eventDataLines.push(line);
          }
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        processSseChunk(decoder.decode(value, { stream: true }));
      }

      processSseChunk(decoder.decode());
      if (streamBuffer.trim()) {
        eventDataLines.push(streamBuffer.trim());
        streamBuffer = '';
      }
      flushSseEvent();

      applyAiUpdate(true);

      const next = [...messages];
      const target = next[aiIndex];
      if (target && target.type === 'ai') {
        next[aiIndex] = {
          ...target,
          content,
          reasoning,
          streaming: false,
          followUpsLoading: target.followUpsLoading ?? false,
        };
        messages = next;
      }

      void loadExtractionHistory();

    } catch (err: unknown) {
      const errorText = err instanceof DOMException && err.name === 'AbortError'
        ? 'Request timed out. Please try again.'
        : err instanceof Error
          ? err.message
          : 'Chat failed';
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

  async function openBillingModal() {
    await refreshSubscriptionStatus();
    if (!selectedPackId && creditPacks.length > 0) {
      selectedPackId = creditPacks[0].id;
    }
    isBillingModalOpen = true;
  }

  function closeBillingModal() {
    if (isCreatingCheckout) return;
    isBillingModalOpen = false;
  }

  async function handleBuyCredits() {
    if (isCreatingCheckout) return;
    if (activeSubscription) {
      messages = [
        ...messages,
        {
          id: makeMessageId('system'),
          type: 'system',
          text: 'You already have an active subscription. Cancel it before buying another one.',
        },
      ];
      return;
    }
    if (!selectedPackId) {
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: 'No credit pack is configured yet.' }];
      return;
    }

    try {
      isCreatingCheckout = true;
      const session = await authStore.createCreditsCheckout(selectedPackId);
      window.location.href = session.checkoutUrl;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to open checkout';
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: message }];
    } finally {
      isCreatingCheckout = false;
    }
  }

  async function handleCancelSubscription() {
    if (isCancellingSubscription) return;
    const confirmed = window.confirm('Cancel your subscription at the next billing date?');
    if (!confirmed) return;

    try {
      isCancellingSubscription = true;
      const result = await authStore.cancelActiveSubscription();
      messages = [
        ...messages,
        {
          id: makeMessageId('system'),
          type: 'system',
          text: result.alreadyScheduled
            ? 'Cancellation was already scheduled.'
            : 'Subscription cancellation scheduled for next billing date.',
        },
      ];
      await refreshSubscriptionStatus();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to cancel subscription';
      messages = [...messages, { id: makeMessageId('system'), type: 'system', text: message }];
    } finally {
      isCancellingSubscription = false;
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

      <!-- Settings button -->
      <button
        onclick={() => { isSettingsWindowOpen = true; }}
        class="w-full mt-4 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-xs font-mono tracking-wide transition-all duration-200"
        style="border-color:#ffffff1f; color:#99a3bf; background:#0a0d14"
      >
        <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
        Settings & History
      </button>

      <div class="mt-4 mb-2">
        <p class="text-[9px] font-mono tracking-[2px] uppercase px-1" style="color:#4a4a5e">Templates</p>
      </div>
      <div class="flex flex-col gap-2 px-1 mb-2.5">
        <input
          class="template-input"
          placeholder="Template name"
          bind:value={templateName}
          maxlength="80"
        />
        <input
          class="template-input"
          placeholder="Values, separated, by commas"
          bind:value={templateFieldsCsv}
          maxlength="1500"
        />
        <button
          class="template-create-btn"
          type="button"
          onclick={createTemplate}
          disabled={isCreatingTemplate}
        >
          {isCreatingTemplate ? 'Saving...' : 'Save template'}
        </button>
        {#if templateError}
          <p class="text-[10px] font-mono px-0.5" style="color:#ff8a8a">{templateError}</p>
        {/if}
      </div>

      {#if isLoadingTemplates}
        <div class="text-[10px] font-mono px-2" style="color:#4a4a5e">Loading templates...</div>
      {:else if templates.length === 0}
        <div class="text-[10px] font-mono px-2" style="color:#4a4a5e">No templates yet</div>
      {:else}
        <div class="flex flex-col gap-2">
          {#each templates as template (template.id)}
            <div class="template-item-row px-1">
              <button class="template-btn w-full flex items-start gap-2.5 px-3 py-2 rounded-lg text-left transition-all" style="border:1px solid #ffffff0d" onclick={() => void applyTemplate(template)}>
                <svg class="w-3.5 h-3.5 shrink-0 mt-0.5" style="color:#00e5a0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
                <span class="flex flex-col min-w-0 gap-0.5">
                  <strong class="text-[11px] font-mono truncate" style="color:#d7d7e8">{template.name}</strong>
                  <span class="text-[10px] font-mono leading-snug truncate" style="color:#4a4a5e">{template.fields_csv}</span>
                </span>
              </button>
              <button
                class="template-delete-btn"
                type="button"
                onclick={() => void deleteTemplate(template.id)}
                disabled={deletingTemplateId === template.id}
              >
                {deletingTemplateId === template.id ? '...' : 'Delete'}
              </button>
            </div>
          {/each}
        </div>
      {/if}
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

      <button
        onclick={openBillingModal}
        disabled={isCreatingCheckout || creditPacks.length === 0}
        class="w-full py-2 rounded-lg text-xs font-mono font-medium transition-all duration-200"
        style="background:#00e5a014; border:1px solid #00e5a026; color:#00e5a0"
      >
        {creditPacks.length === 0 ? 'No plans configured' : '+ Buy credits'}
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
        <div class="flex items-center gap-2 px-3 py-1.5 rounded-full min-w-0 max-w-[52vw]" style="background:#18181e; border:1px solid #ffffff0d">
          <svg class="w-3 h-3 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          <span class="text-xs font-mono truncate" title={activeFileName || 'No file selected'} style="color:rgba(255,255,255,0.8)">{activeFileName || 'No file selected'}</span>
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
                <span class="text-[10px] font-mono" style="color:#4a4a5e">
                  {msg.timestamp}{msg.creditsUsed !== undefined ? ` · ${formatCredits(msg.creditsUsed)} ${msg.creditsUsed === 1 ? 'credit' : 'credits'} used` : ''}
                </span>
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
                {#if msg.streaming && !msg.content.trim()}
                  <span class="generation-dots" aria-label="Generating response"><span></span><span></span><span></span></span>
                {/if}
                {@html renderMarkdown(msg.content)}{#if msg.streaming && msg.content.trim()}<span class="typing-cursor"></span>{/if}
              </div>
              {#if !msg.streaming}
                {#if msg.suggestedQuestions?.length}
                  <div class="mt-3 rounded-2xl p-3" style="background:#111116; border:1px solid #ffffff0d">
                    <div class="flex items-center gap-2 mb-2">
                      <span class="text-[10px] font-mono uppercase tracking-[0.18em]" style="color:#4a4a5e">Suggested follow-ups</span>
                    </div>
                    <div class="flex flex-col gap-2">
                      {#each msg.suggestedQuestions as question (question)}
                        <button
                          class="follow-up-btn text-left px-3 py-2 rounded-xl text-sm leading-relaxed transition-all"
                          style="background:#18181e; border:1px solid #ffffff0d; color:rgba(255,255,255,0.85)"
                          onclick={() => void sendMessage({ followUp: true, text: question })}
                        >
                          {question}
                        </button>
                      {/each}
                    </div>
                  </div>
                {:else if msg.followUpsLoading}
                  <div class="mt-3 rounded-2xl p-3" style="background:#111116; border:1px solid #ffffff0d">
                    <div class="flex items-center gap-2 mb-2">
                      <span class="text-[10px] font-mono uppercase tracking-[0.18em]" style="color:#4a4a5e">Suggested follow-ups</span>
                    </div>
                    <div class="flex flex-col gap-2">
                      {#each [1, 2, 3] as row (row)}
                        <div class="follow-up-skeleton"></div>
                      {/each}
                    </div>
                  </div>
                {/if}
                <div class="flex items-center gap-2 mt-2.5">
                  <button class="action-btn flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono transition-all" style="color:#4a4a5e; border:1px solid transparent" onclick={() => void copyAssistantMessage(msg)}>
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                    </svg>
                    Copy
                  </button>
                  <div class="relative">
                    <button
                      class="action-btn flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono transition-all"
                      style="color:#4a4a5e; border:1px solid transparent"
                      onclick={() => {
                        exportMenuForId = exportMenuForId === msg.id ? null : msg.id;
                      }}
                    >
                      <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                      </svg>
                      Download as
                    </button>
                    {#if exportMenuForId === msg.id}
                      <div class="export-menu rounded-xl p-1.5" style="background:#111116; border:1px solid #ffffff14">
                        <button class="export-menu-item" onclick={() => void exportFromMenu(msg, 'csv')}>CSV</button>
                        <button class="export-menu-item" onclick={() => void exportFromMenu(msg, 'json')}>JSON</button>
                        <button class="export-menu-item" onclick={() => void exportFromMenu(msg, 'xlsx')}>Excel (.xlsx)</button>
                      </div>
                    {/if}
                  </div>
                  <button class="action-btn flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-mono transition-all" style="color:#4a4a5e; border:1px solid transparent" onclick={() => void shareChatAction()}>
                    <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/>
                    </svg>
                    Share
                  </button>
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
          onclick={() => void sendMessage()}
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

  {#if notificationToast}
    <div class="toast-shell" class:toast-hidden={!notificationToast.visible} role="status" aria-live="polite">
      <div class="w-1.5 h-1.5 rounded-full" style="background:#00e5a0"></div>
      <span>{notificationToast.text}</span>
    </div>
  {/if}

  {#if shareDialogOpen}
    <button class="share-dialog-backdrop" aria-label="Close share dialog" onclick={closeShareDialog}></button>
    <div class="share-dialog" role="dialog" aria-modal="true" aria-label="Share chat">
      <div class="share-dialog-head">
        <h3>Share chat</h3>
        <button class="share-close-btn" onclick={closeShareDialog} aria-label="Close share dialog">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      {#if shareDialogLoading}
        <p class="share-dialog-note">Creating secure link...</p>
      {:else if shareDialogError}
        <p class="share-dialog-error">{shareDialogError}</p>
      {:else if shareDialogUrl}
        <p class="share-dialog-note">Anyone with this link can view the shared snapshot.</p>
        <div class="share-link-box">{shareDialogUrl}</div>
        <div class="share-actions">
          <button class="share-action-btn" onclick={() => void copyShareLink()}>Copy link</button>
          <button class="share-action-btn" onclick={() => shareDialogUrl && window.open(shareDialogUrl, '_blank', 'noopener,noreferrer')}>Open link</button>
        </div>
      {/if}
    </div>
  {/if}

  {#if isSettingsWindowOpen}
    <button class="settings-dialog-backdrop" aria-label="Close settings" onclick={() => { isSettingsWindowOpen = false; }}></button>
    <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings and extraction history">
      <div class="settings-dialog-head">
        <h3>Settings & History</h3>
        <button class="settings-close-btn" onclick={() => { isSettingsWindowOpen = false; }} aria-label="Close settings">
          <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="settings-content">
        <!-- Extraction History Section -->
        <div class="settings-section">
          <h4 class="settings-section-title">Extraction History (Last 30 Days)</h4>
          
          <div class="px-2.5 py-2 rounded-lg mb-3" style="background:#18181e; border:1px solid #ffffff0d">
            <div class="flex items-center gap-2">
              <svg class="w-3 h-3 shrink-0" style="color:#4a4a5e" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
              </svg>
              <input
                value={extractionQuery}
                oninput={handleExtractionSearchInput}
                type="text"
                placeholder="Search extractions"
                class="bg-transparent text-[10px] font-mono text-white placeholder-muted w-full focus:ring-0"
                style="color:white"
              />
            </div>
          </div>

          {#if isLoadingExtractions}
            <div class="px-3 py-3 text-[10px] font-mono text-center" style="color:#4a4a5e">Loading extraction history...</div>
          {:else if extractionError}
            <div class="px-3 py-3 text-[10px] font-mono text-center" style="color:#ff8787">{extractionError}</div>
          {:else if extractionHistory.length === 0}
            <div class="px-3 py-3 text-[10px] font-mono text-center" style="color:#4a4a5e">No extractions found in the last 30 days.</div>
          {:else}
            <div class="extraction-history-modal-scroll">
              <div class="flex flex-col gap-2">
                {#each extractionHistory as extraction (extraction.id)}
                  <div class="rounded-lg p-2.5" style="background:#0a0d14; border:1px solid #ffffff0d">
                    <div class="flex items-center justify-between gap-2 mb-1">
                      <p class="text-[10px] font-semibold truncate" style="color:rgba(255,255,255,0.85)">{extraction.file_name}</p>
                      <span class="text-[8px] font-mono shrink-0" style="color:#4a4a5e">{formatRelativeTime(extraction.created_at)}</span>
                    </div>
                    <p class="text-[9px] leading-snug mb-0.5" style="color:#8b90a5">P: {shorten(extraction.prompt, 72)}</p>
                    <p class="text-[9px] leading-snug mb-2" style="color:#4a4a5e">R: {shorten(extraction.result, 76)}</p>
                    <div class="flex items-center gap-1.5">
                      <button
                        class="px-2 py-1 rounded text-[8px] font-mono transition-all"
                        style="background:#18181e; border:1px solid #ffffff0d; color:#c9c9d9"
                        onclick={() => void openExtractionDocument(extraction, false)}
                      >
                        Open
                      </button>
                      <button
                        class="px-2 py-1 rounded text-[8px] font-mono transition-all"
                        style="background:#00e5a014; border:1px solid #00e5a026; color:#00e5a0"
                        onclick={() => void openExtractionDocument(extraction, true)}
                      >
                        Re-run
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#if isBillingModalOpen}
    <button class="fixed inset-0 z-40" style="background:rgba(5,7,10,0.68)" onclick={closeBillingModal} aria-label="Close billing modal"></button>
    <div class="fixed inset-0 z-50 grid place-items-center px-4" aria-label="Choose monthly credit plan" role="dialog" aria-modal="true">
      <div class="w-full max-w-3xl rounded-2xl p-5" style="background:#101218; border:1px solid #ffffff1a">
        <div class="flex items-center justify-between mb-4">
          <div>
            <h2 class="text-lg font-semibold" style="color:#f0f2f8">Choose a monthly plan</h2>
            <p class="text-xs font-mono" style="color:#8b90a5">Credits are added on each successful monthly payment.</p>
          </div>
          <button class="p-2 rounded-md" style="color:#8b90a5; border:1px solid #ffffff1a" onclick={closeBillingModal} disabled={isCreatingCheckout} aria-label="Close plans modal">
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="grid gap-3 md:grid-cols-3">
          {#each creditPacks as pack (pack.id)}
            <button
              class="text-left rounded-xl p-4 transition-all"
              style="background:{selectedPackId === pack.id ? '#00e5a012' : '#0b0d13'}; border:1px solid {selectedPackId === pack.id ? '#00e5a054' : '#ffffff1a'}"
              onclick={() => {
                selectedPackId = pack.id;
              }}
            >
              <p class="text-xs font-mono uppercase tracking-wider" style="color:#9aa0b7">{pack.label}</p>
              <p class="text-2xl font-semibold mt-1" style="color:#f5f7ff">{pack.credits}</p>
              <p class="text-xs font-mono" style="color:#9aa0b7">credits{pack.interval === 'month' ? ' per month' : pack.interval === 'year' ? ' per year' : ''}</p>
              <p class="text-sm font-semibold mt-4" style="color:#00e5a0">{formatPrice(pack)}{formatInterval(pack)}</p>
            </button>
          {/each}
        </div>

        <div class="mt-5 flex items-center justify-between gap-3">
          <p class="text-xs font-mono" style="color:#8b90a5">
            {#if activeSubscription}
              Active subscription: {activeSubscription.status}
              {#if activeSubscription.nextBillingDate}
                · next billing {new Date(activeSubscription.nextBillingDate).toLocaleDateString()}
              {/if}
              {#if activeSubscription.cancelAtNextBillingDate}
                · cancellation scheduled
              {/if}
            {:else if selectedPack()}
              Selected: {selectedPack()?.credits} credits {selectedPack()?.interval === 'month' ? 'per month' : selectedPack()?.interval === 'year' ? 'per year' : 'one time'}
            {:else}
              Select a plan to continue
            {/if}
          </p>
          <button
            onclick={handleBuyCredits}
            disabled={!selectedPackId || isCreatingCheckout || Boolean(activeSubscription)}
            class="px-4 py-2 rounded-lg text-sm font-mono font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style="background:#00e5a014; border:1px solid #00e5a026; color:#00e5a0"
          >
            {#if activeSubscription}
              Subscription already active
            {:else}
              {isCreatingCheckout ? 'Opening checkout...' : 'Continue to checkout'}
            {/if}
          </button>
        </div>

        <div class="mt-3 flex justify-end gap-2">
          <button
            onclick={handleCancelSubscription}
            disabled={isCancellingSubscription || Boolean(activeSubscription?.cancelAtNextBillingDate)}
            class="px-3 py-1.5 rounded-md text-xs font-mono transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            style="background:#3a1114; border:1px solid #7f1d1d; color:#fecaca"
          >
            {#if activeSubscription?.cancelAtNextBillingDate}
              Cancellation scheduled
            {:else}
              {isCancellingSubscription ? 'Cancelling...' : 'Cancel subscription'}
            {/if}
          </button>
        </div>
      </div>
    </div>
  {/if}
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

  .generation-dots {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-right: 0.45rem;
    vertical-align: middle;
  }

  .generation-dots span {
    width: 0.38rem;
    height: 0.38rem;
    border-radius: 999px;
    background: #00e5a0;
    opacity: 0.3;
    animation: pulseDot 1s infinite ease-in-out;
  }

  .generation-dots span:nth-child(2) {
    animation-delay: 0.16s;
  }

  .generation-dots span:nth-child(3) {
    animation-delay: 0.32s;
  }

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
  .template-btn:hover { background: #18181e; border-color: #ffffff16 !important; }
  .template-btn:hover strong { color: white !important; }
  .template-item-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.35rem;
    align-items: center;
  }
  .template-input {
    width: 100%;
    border-radius: 0.45rem;
    border: 1px solid #ffffff12;
    background: #14141b;
    color: #d5d5e3;
    padding: 0.46rem 0.58rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    outline: none;
  }
  .template-input::placeholder { color: #505068; }
  .template-input:focus {
    border-color: #00e5a030;
    box-shadow: 0 0 0 1px #00e5a014;
  }
  .template-create-btn {
    width: 100%;
    border-radius: 0.45rem;
    border: 1px solid #00e5a026;
    background: #00e5a014;
    color: #00e5a0;
    padding: 0.5rem 0.62rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    transition: all 0.15s ease;
  }
  .template-create-btn:hover:not(:disabled) {
    background: #00e5a024;
    border-color: #00e5a03d;
  }
  .template-create-btn:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }
  .template-delete-btn {
    border: 1px solid #7f1d1d;
    background: #301014;
    color: #fecaca;
    border-radius: 0.45rem;
    padding: 0.43rem 0.55rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: all 0.15s ease;
  }
  .template-delete-btn:hover:not(:disabled) {
    background: #4a151d;
    border-color: #b91c1c;
  }
  .template-delete-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .chip:hover { border-color: #00e5a026 !important; color: #00e5a0 !important; background: #00e5a014 !important; }
  .action-btn:hover { color: white !important; background: #18181e !important; border-color: #ffffff0d !important; }
  .input-box:focus-within { border-color: #ffffff16 !important; }

  .export-menu {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    min-width: 9.6rem;
    z-index: 24;
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.35);
  }

  .export-menu-item {
    width: 100%;
    border: 1px solid transparent;
    background: transparent;
    color: #c7cbe0;
    border-radius: 0.55rem;
    text-align: left;
    padding: 0.38rem 0.55rem;
    font-size: 0.68rem;
    font-family: 'JetBrains Mono', monospace;
    transition: all 0.14s ease;
  }

  .export-menu-item:hover {
    border-color: #ffffff1c;
    background: #1a1a24;
    color: #ffffff;
  }

  .toast-shell {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 70;
    max-width: min(92vw, 24rem);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border: 1px solid #00e5a03a;
    background: #0f1714;
    color: #c4fce6;
    border-radius: 0.75rem;
    padding: 0.6rem 0.8rem;
    font-size: 0.72rem;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.01em;
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.4);
    opacity: 1;
    transform: translateY(0);
    transition: opacity 0.22s ease, transform 0.22s ease;
  }

  .toast-hidden {
    opacity: 0;
    transform: translateY(6px);
  }

  .share-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 58;
    border: none;
    background: rgba(4, 6, 10, 0.7);
  }

  .share-dialog {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    width: min(92vw, 25rem);
    border-radius: 1rem;
    border: 1px solid #ffffff1f;
    background: linear-gradient(160deg, #0f131c 0%, #121826 100%);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    padding: 0.95rem;
    z-index: 60;
  }

  .share-dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .share-dialog-head h3 {
    margin: 0;
    color: #f1f4ff;
    font-size: 0.9rem;
    font-weight: 600;
  }

  .share-close-btn {
    border: 1px solid #ffffff1f;
    background: #171d2a;
    color: #96a0bb;
    border-radius: 0.5rem;
    width: 1.8rem;
    height: 1.8rem;
    display: grid;
    place-items: center;
  }

  .share-dialog-note {
    margin: 0;
    color: #99a3bf;
    font-size: 0.72rem;
    font-family: 'JetBrains Mono', monospace;
  }

  .share-dialog-error {
    margin: 0;
    color: #fecaca;
    font-size: 0.72rem;
    font-family: 'JetBrains Mono', monospace;
  }

  .share-link-box {
    margin-top: 0.55rem;
    background: #0a0f18;
    border: 1px solid #ffffff14;
    border-radius: 0.65rem;
    color: #c6d0ea;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    word-break: break-all;
    padding: 0.55rem 0.62rem;
  }

  .share-actions {
    margin-top: 0.65rem;
    display: flex;
    gap: 0.5rem;
  }

  .share-action-btn {
    border: 1px solid #2a364f;
    background: #172033;
    color: #cfe2ff;
    border-radius: 0.62rem;
    font-size: 0.68rem;
    font-family: 'JetBrains Mono', monospace;
    padding: 0.45rem 0.68rem;
    transition: all 0.14s ease;
  }

  .share-action-btn:hover {
    background: #1f2d46;
    border-color: #3b4f75;
    color: #f2f7ff;
  }

  .settings-dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 58;
    border: none;
    background: rgba(4, 6, 10, 0.7);
  }

  .settings-dialog {
    position: fixed;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(94vw, 28rem);
    max-height: 80vh;
    border-radius: 1.15rem;
    border: 1px solid #ffffff1f;
    background: linear-gradient(160deg, #0f131c 0%, #121826 100%);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
    padding: 1rem;
    z-index: 60;
    display: flex;
    flex-direction: column;
  }

  .settings-dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid #ffffff0d;
  }

  .settings-dialog-head h3 {
    margin: 0;
    color: #f1f4ff;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .settings-close-btn {
    border: 1px solid #ffffff1f;
    background: #171d2a;
    color: #96a0bb;
    border-radius: 0.5rem;
    width: 1.8rem;
    height: 1.8rem;
    display: grid;
    place-items: center;
    transition: all 0.14s ease;
  }

  .settings-close-btn:hover {
    border-color: #ffffff2f;
    background: #1e253a;
    color: #b8c4dc;
  }

  .settings-content {
    flex: 1;
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  .settings-content::-webkit-scrollbar {
    width: 5px;
  }

  .settings-content::-webkit-scrollbar-track {
    background: transparent;
  }

  .settings-content::-webkit-scrollbar-thumb {
    background: #404558;
    border-radius: 3px;
  }

  .settings-content::-webkit-scrollbar-thumb:hover {
    background: #505666;
  }

  .settings-section {
    margin-bottom: 1.5rem;
  }

  .settings-section:last-child {
    margin-bottom: 0;
  }

  .settings-section-title {
    margin: 0 0 0.75rem 0;
    color: #e8ecf7;
    font-size: 0.8rem;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .extraction-history-modal-scroll {
    max-height: 340px;
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  .extraction-history-modal-scroll::-webkit-scrollbar {
    width: 5px;
  }

  .extraction-history-modal-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .extraction-history-modal-scroll::-webkit-scrollbar-thumb {
    background: #404558;
    border-radius: 3px;
  }

  .extraction-history-modal-scroll::-webkit-scrollbar-thumb:hover {
    background: #505666;
  }

  .extraction-history-scroll {
    max-height: 260px;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .follow-up-skeleton {
    height: 2.55rem;
    border-radius: 0.8rem;
    border: 1px solid #ffffff0d;
    background: linear-gradient(90deg, #18181e 0%, #232330 45%, #18181e 100%);
    background-size: 220% 100%;
    animation: skeletonPulse 1.2s ease-in-out infinite;
  }

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
    50% { opacity: 0; }
  }

  @keyframes pulseDot {
    0%, 80%, 100% {
      opacity: 0.25;
      transform: translateY(0);
    }
    40% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }

  @keyframes skeletonPulse {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }
</style>
