/**
 * Run async work over `items` with at most `concurrency` tasks in flight (FIFO via shared queue).
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const cap = Math.max(1, concurrency);
  const queue = [...items];
  const workerCount = Math.min(cap, queue.length);

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) {
        break;
      }
      await fn(item);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
}
