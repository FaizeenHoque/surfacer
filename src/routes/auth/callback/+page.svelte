<script lang="ts">
  import { authStore } from '$lib/authStore';
  import { onMount } from 'svelte';

  let message = $state('');
  let error = $state('');

  onMount(async () => {
    try {
      // Check the hash from the URL
      const hash = window.location.hash;
      if (hash) {
        // Supabase will automatically handle the session from the hash
        // Give it a moment to process
        await new Promise(r => setTimeout(r, 1000));
        
        // Check if user is now authenticated
        const user = await authStore.checkUser();
        if (user) {
          message = 'Email confirmed! Redirecting...';
          setTimeout(() => window.location.href = '/', 2000);
        } else {
          message = 'Email verified successfully!';
          setTimeout(() => window.location.href = '/auth', 2000);
        }
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Failed to verify email';
    }
  });
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
    <h1 class="text-2xl font-semibold text-white text-center mb-2">Confirming email</h1>
    <p class="text-sm text-center mb-8" style="color:#4a4a5e">Please wait...</p>

    <!-- Message -->
    <div class="rounded-2xl p-6" style="background:#111116; border:1px solid #ffffff0d">
      {#if error}
        <div class="p-3 rounded-lg text-sm text-center" style="background:#991b1b26; border:1px solid #7f1d1d80; color:#fca5a5">
          {error}
        </div>
        <button
          onclick={() => window.location.href = '/auth'}
          class="w-full py-2.5 rounded-lg text-sm font-medium transition-all text-center mt-4"
          style="border:1px solid #00e5a026; color:#00e5a0; display:block"
          onmouseenter={e => (e.currentTarget as HTMLElement).style.backgroundColor = '#00e5a014'}
          onmouseleave={e => (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'}
        >
          Back to sign in
        </button>
      {:else}
        <div class="p-3 rounded-lg text-sm text-center" style="background:#064e3b26; border:1px solid #047857b3; color:#a7f3d0">
          {message || 'Processing...'}
        </div>
      {/if}
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
</style>
