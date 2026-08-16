// Retries the callback on CockroachDB serialization failures (SQLSTATE 40001).
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const isSerializationError =
        err?.code === '40001' || err?.message?.includes('restart transaction');

      if (isSerializationError && attempt < maxRetries) {
        attempt++;
        const backoffMs = Math.min(100 * 2 ** attempt, 5_000) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
}
