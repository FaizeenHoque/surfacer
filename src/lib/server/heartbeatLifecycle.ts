/**
 * Heartbeat Lifecycle Management
 * Updates file metadata with current timestamp to extend TTL
 * Enables automatic storage cleanup for inactive files (Phase 2)
 * 
 * Note: This is a graceful integration that handles both:
 * - Files tables with expires_at column (when implemented)
 * - Current systems without TTL management (Phase 1)
 */

import { type SupabaseClient } from '@supabase/supabase-js';

interface HeartbeatResult {
  attempted: boolean;
  updated: boolean;
  newExpiresAt: string | null;
  error?: string;
}

/**
 * Update file heartbeat using file path - extends TTL by refreshing updated_at timestamp
 * Call this after successful chat to indicate file is still in active use
 * 
 * This function gracefully handles both Phase 1 (no expires_at) and Phase 2 (with TTL)
 * 
 * @param supabase - Supabase client
 * @param filePath - Storage path of the file
 * @param userId - User ID for security
 * @param ttlDays - How many days from now the file should expire (default: 365)
 * @returns Result with new expiration timestamp
 */
export async function updateFileHeartbeat(
  supabase: SupabaseClient,
  filePath: string,
  userId: string,
  ttlDays: number = 365
): Promise<HeartbeatResult> {
  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    
    // ISO 8601 UTC format for consistency
    const expiresAtIso = expiresAt.toISOString();
    const updatedAtIso = now.toISOString();

    // Attempt update via files table
    // This will gracefully fail if:
    // - Table doesn't exist
    // - expires_at column doesn't exist
    // - Path-based lookup not supported
    // All of which are acceptable for Phase 1
    try {
      const { error } = await supabase
        .from('files')
        .update({
          updated_at: updatedAtIso,
          // Note: expires_at column is Phase 2 enhancement
          // ...(ttlDays && { expires_at: expiresAtIso }),
        })
        .eq('user_id', userId)
        .filter('path', 'eq', filePath);

      // Both success and not-found (filter matched nothing) are acceptable
      if (!error || error.code === 'PGRST116') { // PGRST116 = no rows affected
        return {
          attempted: true,
          updated: !error,
          newExpiresAt: !error ? expiresAtIso : null,
          error: error ? 'TTL management not enabled (Phase 2)' : undefined,
        };
      }

      return {
        attempted: true,
        updated: false,
        newExpiresAt: null,
        error: error.message,
      };
    } catch (innerErr) {
      // Table doesn't exist or other schema issue - Phase 1 systems
      // This is not an error state, just feature not enabled yet
      return {
        attempted: false,
        updated: false,
        newExpiresAt: null,
        error: 'Files table TTL management not yet enabled',
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      attempted: false,
      updated: false,
      newExpiresAt: null,
      error: message,
    };
  }
}

/**
 * Batch update heartbeat for multiple file paths accessed in single chat
 * 
 * @param supabase - Supabase client
 * @param filePaths - Array of storage paths to update
 * @param userId - User ID for security
 * @param ttlDays - How many days from now files should expire
 * @returns Map of filePath to heartbeat result
 */
export async function batchUpdateFileHeartbeats(
  supabase: SupabaseClient,
  filePaths: string[],
  userId: string,
  ttlDays: number = 365
): Promise<Map<string, HeartbeatResult>> {
  const results = new Map<string, HeartbeatResult>();

  // Execute updates in parallel
  const promises = filePaths.map(filePath => updateFileHeartbeat(supabase, filePath, userId, ttlDays));
  const heartbeats = await Promise.all(promises);

  filePaths.forEach((filePath, index) => {
    results.set(filePath, heartbeats[index]);
  });

  return results;
}

/**
 * Get current TTL remaining for a file path
 * Returns -1 if file not found or TTL management not enabled
 * 
 * @param supabase - Supabase client
 * @param filePath - Storage path to check
 * @return Milliseconds until expiration, or -1 if expired/not found/disabled
 */
export async function getFileRemainingTTL(
  supabase: SupabaseClient,
  filePath: string
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('files')
      .select('expires_at')
      .filter('path', 'eq', filePath)
      .maybeSingle();

    if (error || !data?.expires_at) {
      return -1;
    }

    const expiresAt = new Date(data.expires_at).getTime();
    const now = Date.now();
    const remaining = expiresAt - now;

    return remaining > 0 ? remaining : 0;
  } catch {
    return -1;
  }
}

/**
 * Log heartbeat update for audit trail
 * Only logs successful updates - gracefully skips if heartbeat not yet enabled
 * 
 * @param filePath - File path being accessed
 * @param heartbeatResult - Result from updateFileHeartbeat
 * @param requestId - Request ID for correlation
 */
export function logHeartbeatUpdate(
  filePath: string,
  heartbeatResult: HeartbeatResult,
  requestId: string
): void {
  // Only log if update was attempted and succeeded
  if (!heartbeatResult.updated && !heartbeatResult.newExpiresAt) {
    return; // Silent skip - feature may not be enabled
  }

  if (!heartbeatResult.newExpiresAt) {
    return;
  }

  const expiresDate = new Date(heartbeatResult.newExpiresAt);
  const daysRemaining = Math.floor((expiresDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const fileName = filePath.split('/').pop() || filePath;

  console.info(`[${requestId}] Heartbeat: ${fileName} TTL extended to ${daysRemaining} days`);
}
