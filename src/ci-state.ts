export type CiTriState = "success" | "failure" | "pending";

export interface CiChecksSummary {
  success: number;
  failure: number;
  pending: number;
}

export interface CiLegacyStatus {
  state: "success" | "failure" | "pending" | "error" | null;
  hasStatuses: boolean;
}

/**
 * Merge legacy commit status + checks summary into one tri-state for sidebar UI.
 * Rule order intentionally mirrors existing behavior in `api.ts`.
 */
export function reduceCiToTriState(input: {
  status: CiLegacyStatus | null;
  checks: CiChecksSummary | null;
}): CiTriState {
  const statusState = input.status?.state ?? null;
  const hasStatuses = input.status?.hasStatuses ?? false;
  const checks = input.checks;

  if (statusState === "failure" || statusState === "error") return "failure";
  if (checks && checks.failure > 0) return "failure";

  if (statusState === "pending" && hasStatuses) return "pending";
  if (checks && checks.pending > 0) return "pending";

  if (statusState === "success" || (checks && checks.success > 0)) return "success";
  return "pending";
}
