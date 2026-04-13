import { writable } from 'svelte/store';

import { supabase } from './supabaseClient';

async function fetchWithTimeout(resource: RequestInfo | URL, init: RequestInit = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(resource, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export interface AuthUser {
  id: string;
  email: string;
  email_confirmed_at?: string;
  user_metadata?: Record<string, unknown>;
}

export interface CreditPackOption {
  id: string;
  credits: number;
  priceCents: number | null;
  currency: string | null;
  label: string;
  interval: 'month' | 'year' | 'one_time';
}

function createAuthStore() {
  const { subscribe, set, update } = writable<AuthUser | null>(null);

  return {
    subscribe,
    set,
    update,
    signin: async (email: string, password: string) => {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      if (data.user) {
        set({
          id: data.user.id,
          email: data.user.email || '',
          email_confirmed_at: data.user.email_confirmed_at,
          user_metadata: data.user.user_metadata,
        });
      }
      return data;
    },
    signup: async (email: string, password: string) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      return data;
    },
    logout: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      set(null);
    },
    resetPassword: async (email: string) => {
      const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/update-password`,
      });
      if (error) throw error;
      return data;
    },
    updatePassword: async (newPassword: string) => {
      const { data, error } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (error) throw error;
      return data;
    },
    checkUser: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        set({
          id: user.id,
          email: user.email || '',
          email_confirmed_at: user.email_confirmed_at,
          user_metadata: user.user_metadata,
        });
      } else {
        set(null);
      }
      return user;
    },
    bootstrapCredits: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('No active session');
      }

      const response = await fetchWithTimeout('/api/account/bootstrap', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to bootstrap credits');
      }

      return payload as { credits: number; isNewUser: boolean };
    },
    createCreditsCheckout: async (packId?: string) => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('No active session');
      }

      const response = await fetchWithTimeout('/api/billing/checkout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ packId: packId || null }),
      }, 25_000);

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to create checkout session');
      }

      return payload as { checkoutUrl: string; sessionId: string };
    },
    getCreditPacks: async () => {
      const response = await fetchWithTimeout('/api/billing/packs', {
        method: 'GET',
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to load credit packs');
      }

      return (payload.packs || []) as CreditPackOption[];
    },
    createBillingPortalSession: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        throw new Error('No active session');
      }

      const response = await fetchWithTimeout('/api/billing/portal', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      }, 25_000);

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to open billing portal');
      }

      return payload as { url: string };
    },
  };
}

export const authStore = createAuthStore();
