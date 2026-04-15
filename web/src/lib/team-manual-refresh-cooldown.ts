export const TEAM_MANUAL_REFRESH_COOLDOWN_MS = 30_000;

export function teamManualRefreshAllowed(lastTriggerMs: number | null, nowMs: number): boolean {
  if (lastTriggerMs == null) return true;
  return nowMs - lastTriggerMs >= TEAM_MANUAL_REFRESH_COOLDOWN_MS;
}
