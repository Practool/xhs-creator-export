export class StoppedError extends Error { constructor() { super('已停止，已验证完成的数据保留'); } }
export class GuardError extends Error {}
export class StructureError extends GuardError {}
export class NeedsLoginError extends Error {}
export class StorageError extends Error {}
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function fatal(error: unknown): boolean {
  return error instanceof StoppedError || error instanceof GuardError || error instanceof StorageError;
}
export async function retry<T>(task: () => Promise<T>, retries: number, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    checkSignal(signal);
    try { return await task(); } catch (error) {
      if (fatal(error) || error instanceof NeedsLoginError || attempt >= retries) throw error;
      await delay(Math.min(250 * 2 ** attempt, 2000), signal);
    }
  }
}
export function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw new StoppedError(); }
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    function stop() { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(new StoppedError()); }
    signal?.addEventListener('abort', stop, { once: true });
  });
}
