/**
 * Per-printer print queue: one job at a time per printer, in arrival order, with a gap between
 * jobs; other printers never wait, and a failed job does not block the next.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/print-queue.test.ts
 */
import assert from 'node:assert/strict';
import { enqueuePrintJob, printQueueDepth } from '../main/printers/print-queue';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function main() {
  {
    const events: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const job = (name: string, ms: number) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      events.push(`start ${name}`);
      await delay(ms);
      events.push(`end ${name}`);
      running--;
      return name;
    };
    const started = Date.now();
    const results = await Promise.all([
      enqueuePrintJob('kitchen', job('a', 40), 50),
      enqueuePrintJob('kitchen', job('b', 10), 50),
      enqueuePrintJob('kitchen', job('c', 10), 50),
    ]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.equal(maxRunning, 1, 'one job at a time on the same printer');
    assert.deepEqual(events, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    assert.ok(Date.now() - started >= 40 + 10 + 10 + 2 * 50 - 5, 'jobs are spaced by the gap');
    console.log('  ✓ jobs for one printer run one at a time, in order, with a gap');
  }

  {
    let bar = '';
    const slow = enqueuePrintJob('kitchen-2', () => delay(80).then(() => 'kitchen'), 0);
    await enqueuePrintJob(
      'bar',
      async () => {
        bar = 'done';
      },
      0,
    );
    assert.equal(bar, 'done');
    assert.equal(printQueueDepth('kitchen-2'), 1, 'the bar printed while the kitchen was busy');
    await slow;
    console.log('  ✓ another printer does not wait');
  }

  {
    const failed = enqueuePrintJob(
      'receipt',
      async () => {
        throw new Error('paper out');
      },
      0,
    );
    const next = enqueuePrintJob('receipt', async () => 'printed', 0);
    await assert.rejects(failed, /paper out/);
    assert.equal(await next, 'printed', 'a failed job does not hold up the next');
    await delay(5);
    assert.equal(printQueueDepth('receipt'), 0);
    console.log('  ✓ a failed job does not block the queue');
  }

  console.log('Print queue tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
