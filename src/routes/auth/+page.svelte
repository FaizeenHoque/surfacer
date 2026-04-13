<script lang="ts">
  import { authStore } from '$lib/authStore';
  import { goto } from '$app/navigation';

  let email = $state('');
  let password = $state('');
  let error = $state('');
  let loading = $state(false);

  async function handleLogin() {
    error = '';
    loading = true;

    try {
      await authStore.signin(email, password);
      goto('/');
    } catch (err: any) {
      error = err.message || 'Failed to sign in';
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      handleLogin();
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
    <h1 class="text-2xl font-semibold text-white text-center mb-2">Welcome back</h1>
    <p class="text-sm text-center mb-8" style="color:#4a4a5e">Sign in to your Surfacer account</p>

    <!-- Form -->
    <div class="space-y-4 rounded-2xl p-6" style="background:#111116; border:1px solid #ffffff0d">
      <!-- Email -->
      <div>
        <label for="signin_email" class="text-xs font-mono uppercase" style="color:#4a4a5e">Email</label>
        <input
          id="signin_email"
          type="email"
          bind:value={email}
          placeholder="you@example.com"
          onkeydown={handleKeydown}
          class="w-full mt-1.5 px-3 py-2.5 rounded-lg text-sm outline-none focus:ring-0 transition-all"
          style="background:#18181e; border:1px solid #ffffff0d; color:white"
          disabled={loading}
        />
      </div>

      <!-- Password -->
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <label for="signin_password" class="text-xs font-mono uppercase" style="color:#4a4a5e">Password</label>
          <a
            href="/auth/reset-password"
            class="text-[11px] font-mono transition-colors"
            style="color:#00e5a0"
            onmouseenter={e => (e.currentTarget as HTMLElement).style.color = '#00d8a0'}
            onmouseleave={e => (e.currentTarget as HTMLElement).style.color = '#00e5a0'}
          >
            Forgot?
          </a>
        </div>
        <input
          id="signin_password"
          type="password"
          bind:value={password}
          placeholder="••••••••"
          onkeydown={handleKeydown}
          class="w-full px-3 py-2.5 rounded-lg text-sm outline-none focus:ring-0 transition-all"
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

      <!-- Sign In Button -->
      <button
        onclick={handleLogin}
        disabled={loading || !email || !password}
        class="w-full py-2.5 rounded-lg text-sm font-medium transition-all duration-200 mt-6 disabled:opacity-50 disabled:cursor-not-allowed"
        style="background:#00e5a0; color:#09090d"
      >
        {loading ? 'Signing in...' : 'Sign in'}
      </button>

      <div class="relative">
        <div class="absolute inset-0 flex items-center">
          <div class="w-full h-px" style="background:#ffffff0d"></div>
        </div>
        <div class="relative flex justify-center text-xs">
          <span class="px-2" style="background:#111116; color:#4a4a5e">Don't have an account?</span>
        </div>
      </div>

      <a
        href="/auth/signup"
        class="w-full py-2.5 rounded-lg text-sm font-medium transition-all text-center"
        style="border:1px solid #00e5a026; color:#00e5a0"
        onmouseenter={e => (e.currentTarget as HTMLElement).style.backgroundColor = '#00e5a014'}
        onmouseleave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'}
      >
        Create an account
      </a>
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
