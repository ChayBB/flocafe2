/**
 * KDS speech: the POS computer reads text in its own offline voice for the KDS display. Bad
 * requests are refused, and a language this computer cannot speak answers 204 so the display
 * stays quiet instead of failing.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/kds-speech.test.ts
 */
const express = require('express');
const { startServer, assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const { handleKdsSpeech } = require('../main/services/kds-speech');

async function main() {
  console.log('KDS speech');
  console.log('='.repeat(60));
  const app = express();
  app.use(express.json());
  app.post('/speech', handleKdsSpeech);
  const { baseUrl, server } = await startServer(app);
  const speak = (body: unknown) =>
    fetch(`${baseUrl}/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  try {
    assertEqualOrThrow((await speak({ lang: 'th-TH' })).status, 400, 'text is required');
    assertEqualOrThrow((await speak({ text: 'x'.repeat(501), lang: 'th-TH' })).status, 400, 'long text is refused');
    assertEqualOrThrow((await speak({ text: 'hello', lang: 'th TH; rm' })).status, 400, 'odd languages are refused');
    assertEqualOrThrow((await speak({ text: 'hello', lang: 'zz-ZZ' })).status, 204, 'a missing voice answers 204');

    const thai = await speak({ text: 'โต๊ะ 5 พร้อมเสิร์ฟ', lang: 'th-TH' });
    if (thai.status === 200) {
      const audio = Buffer.from(await thai.arrayBuffer());
      assertEqualOrThrow(thai.headers.get('content-type'), 'audio/wav', 'speech comes back as WAV');
      assertEqualOrThrow(audio.subarray(0, 4).toString('ascii'), 'RIFF', 'the WAV has a RIFF header');
      assertOrThrow(audio.length > 10000, 'Thai text becomes real audio, not a garbled stub');
    } else {
      assertEqualOrThrow(thai.status, 204, 'a computer without a Thai voice answers 204');
      console.log('  (no Thai voice on this computer; audio checks skipped)');
    }
    console.log('\nAll KDS speech checks passed');
  } finally {
    server.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
