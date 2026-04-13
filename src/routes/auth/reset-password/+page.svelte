<script lang="ts">
  import { authStore } from '$lib/authStore';

  let email = $state('');
  let error = $state('');
  let loading = $state(false);
  let message = $state('');
  let showCreateAccount = $state(false);

  async function handleResetPassword() {
    error = '';
    message = '';
    showCreateAccount = false;
    loading = true;

    try {
      const existsResponse = await fetch('/api/auth/email-exists', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });

      const existsPayload = await existsResponse.json();
      if (!existsResponse.ok) {
        throw new Error(existsPayload.error || 'Unable to verify email');
      }

      if (!existsPayload.exists) {
        showCreateAccount = true;
        error = 'No account found for this email. Please create a new account.';
        return;
      }

      await authStore.resetPassword(email);
      message = 'Check your email for password reset instructions';
      email = '';
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Failed to send reset email';
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      handleResetPassword();
    }
  }
</script>

<div class="grain min-h-screen flex items-center justify-center p-4" style="background:#09090d">
  <div class="w-full max-w-md">
    <!-- Logo -->
    <div class="flex items-center justify-center mb-8">
      <div class="w-10 h-10 rounded-lg flex items-center justify-center" style="background:#00e5a014; border:1px solid #00e5a026">
        <svg class="w-5 h-5" style="color:#00e5a0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
      </div>
    </div>

    <!-- Heading -->
    <h1 class="text-2xl font-semibold text-white text-center mb-2">Reset password</h1>
    <p class="text-sm text-center mb-8" style="color:#4a4a5e">Enter your email to receive reset instructions</p>

    <!-- Form -->
    <div class="space-y-4 rounded-2xl p-6" style="background:#111116; border:1px solid #ffffff0d">
      <!-- Email -->
      <div>
        <label for="email" class="text-xs font-mono uppercase" style="color:#4a4a5e">Email</label>
        <input
          id="email"
          type="email"
          bind:value={email}
          placeholder="you@example.com"
          onkeydown={handleKeydown}
          class="w-full mt-1.5 px-3 py-2.5 rounded-lg text-sm outline-none focus:ring-0 transition-all"
          style="background:#18181e; border:1px solid #ffffff0d; color:white"
          disabled={loading}
        />
      </div>

      <!-- Error -->
      {#if error}
        <div class="p-2.5 rounded-lg text-sm" style="background:#991b1b26; border:1px solid #7f1d1d80; color:#fca5a5">
          {error}
        </div>
      {/if}

      {#if showCreateAccount}
        <button
          onclick={() => (window.location.href = '/auth/signup')}
          class="w-full py-2.5 rounded-lg text-sm font-medium transition-all text-center"
          style="border:1px solid #00e5a026; color:#00e5a0"
          onmouseenter={e => (e.currentTarget as HTMLElement).style.backgroundColor = '#00e5a014'}
          onmouseleave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'}
        >
          Create new account
        </button>
      {/if}

      <!-- Success Message -->
      {#if message}
        <div class="p-2.5 rounded-lg text-sm" style="background:#064e3b26; border:1px solid #047857b3; color:#a7f3d0">
          {message}
        </div>
      {/if}

      <!-- Reset Button -->
      <button
        onclick={handleResetPassword}
        disabled={loading || !email}
        class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-200 mt-6 disabled:opacity-50 disabled:cursor-not-allowed"
        style="background:#00e5a0; color:#09090d"
      >
        {loading ? 'Sending...' : 'Send reset link'}
      </button>

      <div class="relative">
        <div class="absolute inset-0 flex items-center">
          <div class="w-full h-px" style="background:#ffffff0d"></div>
        </div>
        <div class="relative flex justify-center text-xs">
          <span class="px-2" style="background:#111116; color:#4a4a5e">Remember your password?</span>
        </div>
      </div>

      <button
        onclick={() => window.location.href = '/auth'}
        class="w-full py-2.5 rounded-lg text-sm font-medium transition-all text-center"
        style="border:1px solid #00e5a026; color:#00e5a0"
        onmouseenter={e => (e.currentTarget as HTMLElement).style.backgroundColor = '#00e5a014'}
        onmouseleave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'}
      >
        Back to sign in
      </button>
    </div>
  </div>
</div>

<style>
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@300;400;500&display=swap');

  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; font-family: 'Syne', sans-serif; background: #09090d; }
  :global(.font-mono) { font-family: 'JetBrains Mono', monospace; }

  .grain::after {
    content: '';
    position: fixed;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 999;
    opacity: 0.4;
  }

  input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  input::placeholder {
    color: rgba(255, 255, 255, 0.4);
  }
</style>
