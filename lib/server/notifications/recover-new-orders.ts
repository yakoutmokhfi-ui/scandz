import "server-only";
import { getServiceRoleSupabaseClient } from "@/lib/server/supabase-admin";

/** The database owns the immutable cutoff and limits the recovery batch. */
export async function recoverNewOrderNotifications(): Promise<{ recovered: number; failed: number }> {
  const { data, error } = await getServiceRoleSupabaseClient().rpc(
    "recover_new_order_received_notifications", { p_batch_size: 25 },
  );
  if (error) throw new Error("NOTIFICATION_RECOVERY_FAILED");
  const row = Array.isArray(data) ? data[0] : undefined;
  if (!row || !Number.isInteger(row.recovered) || !Number.isInteger(row.failed)) {
    throw new Error("NOTIFICATION_RECOVERY_INVALID_RESULT");
  }
  return { recovered: row.recovered, failed: row.failed };
}
