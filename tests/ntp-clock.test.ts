/**
 * The business clock follows the Thai NTP servers: it applies the measured offset, keeps the
 * last correction offline, and rejects replies that do not answer its own request.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/ntp-clock.test.ts
 */
import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import {
  NTP_SERVERS,
  clockNow,
  clockStatus,
  queryNtpOffset,
  resetClockForTests,
  syncClock,
} from '../main/lib/clock';

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const { now } = require('../main/db');

const NTP_EPOCH_OFFSET = 2208988800;

function writeTimestamp(buffer: Buffer, offset: number, ms: number): void {
  buffer.writeUInt32BE(Math.floor(ms / 1000) + NTP_EPOCH_OFFSET, offset);
  buffer.writeUInt32BE(Math.round(((ms % 1000) / 1000) * 0x100000000) >>> 0, offset + 4);
}

/** A local NTP server whose clock runs `skewMs` ahead of this machine. */
function startFakeNtp(skewMs: number, tamper?: (reply: Buffer) => void): Promise<{ port: number; close: () => void }> {
  const server = dgram.createSocket('udp4');
  server.on('message', (request, remote) => {
    const reply = Buffer.alloc(48);
    reply[0] = 0x24; // version 4, mode 4 (server)
    reply[1] = 2; // stratum
    request.copy(reply, 24, 40, 48); // originate = client's transmit
    writeTimestamp(reply, 32, Date.now() + skewMs);
    writeTimestamp(reply, 40, Date.now() + skewMs);
    tamper?.(reply);
    server.send(reply, remote.port, remote.address);
  });
  return new Promise((resolve) => {
    server.bind(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }),
    );
  });
}

async function main() {
  assertEqualOrThrow(NTP_SERVERS[0], 'time.navy.mi.th', 'the navy time server is asked first');
  assertEqualOrThrow(NTP_SERVERS[1], 'th.pool.ntp.org', 'the Thai NTP pool is the fallback');

  resetClockForTests();
  const ahead = await startFakeNtp(90_000);
  try {
    const offset = await queryNtpOffset('127.0.0.1', { port: ahead.port, timeoutMs: 2000 });
    assertOrThrow(Math.abs(offset - 90_000) < 1000, `the measured offset follows the server (got ${offset} ms)`);

    const synced = await syncClock(['127.0.0.1'], { port: ahead.port, timeoutMs: 2000 });
    assertOrThrow(synced, 'sync succeeds against a reachable server');
    const drift = clockNow().getTime() - Date.now();
    assertOrThrow(Math.abs(drift - 90_000) < 1000, `the business clock applies the offset (got ${drift} ms)`);
    const stamped = new Date(`${now().replace(' ', 'T')}Z`).getTime() - Date.now();
    assertOrThrow(Math.abs(stamped - 90_000) < 2000, `persisted timestamps use the corrected clock (got ${stamped} ms)`);
    assertEqualOrThrow(clockStatus().lastSync?.server, '127.0.0.1', 'the last sync records its server');
  } finally {
    ahead.close();
  }

  // Offline: nothing answers, so the last correction stays.
  const offline = await syncClock(['127.0.0.1'], { port: ahead.port, timeoutMs: 300 });
  assertOrThrow(!offline, 'sync reports failure when no server answers');
  assertOrThrow(Math.abs(clockStatus().offsetMs - 90_000) < 1000, 'the last correction is kept while offline');

  // A reply that does not echo this request's timestamp is rejected.
  const spoof = await startFakeNtp(-500_000, (reply) => reply.fill(0, 24, 32));
  try {
    let rejected = false;
    try {
      await queryNtpOffset('127.0.0.1', { port: spoof.port, timeoutMs: 2000 });
    } catch {
      rejected = true;
    }
    assertOrThrow(rejected, 'a reply that does not answer this request is rejected');
    await syncClock(['127.0.0.1'], { port: spoof.port, timeoutMs: 2000 });
    assertOrThrow(Math.abs(clockStatus().offsetMs - 90_000) < 1000, 'a rejected reply leaves the clock alone');
  } finally {
    spoof.close();
  }

  // An unsynchronised server (stratum 0) is ignored too.
  const unsynced = await startFakeNtp(10_000, (reply) => {
    reply[1] = 0;
  });
  try {
    const ok = await syncClock(['127.0.0.1'], { port: unsynced.port, timeoutMs: 2000 });
    assertOrThrow(!ok, 'an unsynchronised server is not trusted');
  } finally {
    unsynced.close();
  }

  resetClockForTests();
  assertOrThrow(Math.abs(clockNow().getTime() - Date.now()) < 50, 'with no sync the machine clock is used');
  console.log('\nAll NTP clock checks passed');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
