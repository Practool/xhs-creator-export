import type { Download } from 'playwright';
import { checkSignal, StoppedError } from './errors.js';

/** Bound the transfer itself, not only the event that announces a download. */
export async function saveDownload(download: Pick<Download, 'saveAs' | 'cancel'>, filename: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const transfer = download.saveAs(filename);
  void transfer.catch(() => {});
  try {
    await Promise.race([transfer, new Promise<never>((_, reject) => {
      const cancel = (error: Error) => { void download.cancel().catch(() => {}); reject(error); };
      timer = setTimeout(() => cancel(new Error('官方下载超时，已取消传输')), Math.max(1, timeoutMs));
      stop = () => cancel(new StoppedError());
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    })]);
    checkSignal(signal);
  } finally {
    if (timer) clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
  }
}
