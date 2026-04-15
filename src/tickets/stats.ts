export interface RequestStatsSnapshot {
  total: number;
  byOperation: Record<string, number>;
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
