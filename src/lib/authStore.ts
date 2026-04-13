import { writable } from 'svelte/store';

import { supabase } from './supabaseClient';

export interface AuthUser {
  id: string;
  email: string;
  email_confirmed_at?: string;
  user_metadata?: Record<string, unknown>;
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
    updateEmail: async (newEmail: string) => {
      const { data, error } = await supabase.auth.updateUser({
        email: newEmail,
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
  };
}

export const authStore = createAuthStore();
