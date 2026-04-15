export interface RequestStatsSnapshot {
  total: number;
  byOperation: Record<string, number>;
}

/** Per-request stderr logging for Linear GraphQL when `CODE_TRIAGE_LOG_LINEAR=1`. Off under Vitest. */
export function shouldLogLinearRequests(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  return process.env.CODE_TRIAGE_LOG_LINEAR === "1";
}

let linearRequestStats: RequestStatsSnapshot = {
  total: 0,
  byOperation: {},
};

export function recordLinearRequest(operation: string): void {
  linearRequestStats.total += 1;
  linearRequestStats.byOperation[operation] = (linearRequestStats.byOperation[operation] ?? 0) + 1;
}

export function getLinearRequestStatsSnapshot(): RequestStatsSnapshot {
  return {
    total: linearRequestStats.total,
    byOperation: { ...linearRequestStats.byOperation },
  };
}

export function resetLinearRequestStatsForTests(): void {
  linearRequestStats = { total: 0, byOperation: {} };
}
