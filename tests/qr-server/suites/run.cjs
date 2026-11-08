#!/usr/bin/env node
'use strict';

/**
 * Runner for the QR-server harness suites. Kept dependency-free so CI can call it directly.
 *
 *   node tests/qr-server/suites/run.cjs contract
 *   node tests/qr-server/suites/run.cjs sim
 *   node tests/qr-server/suites/run.cjs api        (needs Postgres + a running API)
 *   node tests/qr-server/suites/run.cjs all        (contract + sim; no Docker)
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

const SUITES = {
  contract: 'tests/qr-server/suites/contract/delivery-contract.test.ts',
  sim: 'tests/qr-server/suites/sim/delivery-sim.test.ts',
  api: 'tests/qr-server/suites/api/delivery-api.test.ts',
  e2e: 'tests/qr-server/suites/e2e/delivery-e2e.test.ts',
};

const ALL = ['contract', 'sim'];

function fail(message) {
  console.error(`qr-server harness: ${message}`);
  process.exit(2);
}

function requireEnv(label) {
  const missing = ['DATABASE_URL', 'ADMIN_DATABASE_URL', 'GUEST_QR_SECRET'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) fail(`${label} suite needs ${missing.join(', ')}`);
}

async function preflightApi() {
  requireEnv('api');
  const base = (process.env.POS_API_URL ?? 'http://127.0.0.1:3311').replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/healthz`);
    if (!response.ok) throw new Error(`healthz returned ${response.status}`);
  } catch (error) {
    fail(`api is not reachable at ${base} (${error.message}); start it or set POS_API_URL`);
  }
}

async function preflightE2e() {
  requireEnv('e2e');
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main', 'server.js'))) {
    fail('e2e needs a built FloCafe backend; run npm run build first');
  }
  const bun = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  if (bun.status !== 0) fail('e2e needs bun on PATH');
  for (const url of [
    'http://127.0.0.1:3301/api/health',
    'http://127.0.0.1:3303/api/health',
    'http://127.0.0.1:3311/healthz',
  ]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(400) });
      if (response.ok) fail(`${url} already answers; stop the service using that port first`);
    } catch {
      // closed port: good
    }
  }
}

async function main() {
  const requested = process.argv[2] ?? 'all';
  const names = requested === 'all' ? ALL : [requested];
  for (const name of names) {
    if (!SUITES[name])
      fail(`unknown suite "${name}" (available: ${Object.keys(SUITES).join(', ')}, all)`);
  }
  if (names.includes('api')) await preflightApi();
  if (names.includes('e2e')) await preflightE2e();

  let tsNode;
  try {
    tsNode = require.resolve('ts-node/dist/bin.js', { paths: [ROOT] });
  } catch {
    fail('ts-node is not installed');
  }

  for (const name of names) {
    const file = SUITES[name];
    if (!fs.existsSync(path.join(ROOT, file))) fail(`missing suite file ${file}`);
    console.log(`\n=== ${file} ===`);
    const result = spawnSync(
      process.execPath,
      [tsNode, '--transpile-only', '-P', 'tests/tsconfig.json', file],
      {
        cwd: ROOT,
        stdio: 'inherit',
      },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
