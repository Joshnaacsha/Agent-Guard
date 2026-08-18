// Retries the callback on CockroachDB serialization failures (SQLSTATE 40001).
// `onRetry` fires once per retry (not on the initial attempt) so callers can log the real
// 40001 conflict for the audit trail instead of it happening silently inside the wrapper.
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 5,
  onRetry?: (attempt: number) => void
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      const isSerializationError =
        err?.code === '40001' || err?.message?.includes('restart transaction');

      if (isSerializationError && attempt < maxRetries) {
        attempt++;
        onRetry?.(attempt);
        const backoffMs = Math.min(100 * 2 ** attempt, 5_000) + Math.random() * 100;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
}
