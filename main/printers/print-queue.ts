/** Pause before a printer takes its next job, so tickets come out one by one rather than run together. */
export const PRINT_JOB_GAP_MS = 150;
/** A printer with more jobs than this waiting is logged, since the kitchen is falling behind. */
export const PRINT_QUEUE_WARN_DEPTH = 5;

const tails = new Map<string, Promise<void>>();
const depths = new Map<string, number>();

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs print jobs for the same printer one at a time, in the order they arrive, with a short gap
 * between them. Jobs for different printers do not wait for each other, and a failed job does not
 * hold up the next one.
 */
export function enqueuePrintJob<T>(
  printerKey: string,
  job: () => Promise<T>,
  gapMs = PRINT_JOB_GAP_MS,
): Promise<T> {
  const depth = (depths.get(printerKey) ?? 0) + 1;
  depths.set(printerKey, depth);
  if (depth > PRINT_QUEUE_WARN_DEPTH) {
    console.warn(`[Printer] ${depth} jobs waiting for ${printerKey}`);
  }

  const previous = tails.get(printerKey) ?? Promise.resolve();
  const run = previous.then(job);
  const tail = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      const left = (depths.get(printerKey) ?? 1) - 1;
      if (left > 0) depths.set(printerKey, left);
      else depths.delete(printerKey);
    })
    .then(() => delay(gapMs));
  tails.set(printerKey, tail);
  void tail.then(() => {
    if (tails.get(printerKey) === tail) tails.delete(printerKey);
  });
  return run;
}

/** How many jobs are waiting for or printing on a printer. */
export function printQueueDepth(printerKey: string): number {
  return depths.get(printerKey) ?? 0;
}

export function networkPrinterKey(ip: string, port: number): string {
  return `network:${ip}:${port}`;
}

export function osPrinterKey(printerName: string | undefined): string {
  return `os:${printerName ?? ''}`;
}
