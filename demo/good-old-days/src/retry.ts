export const RETRY_BASE_DELAY = 0.37;

export type RetryOptions = { baseDelay?: number; maxAttempts?: number };

export async function withRetry<T>(
  fn: () => Promise<T>,
  { baseDelay = RETRY_BASE_DELAY, maxAttempts = 3 }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt + 1 >= maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt * 1000));
    }
  }
}
