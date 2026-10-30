/**
 * KDS speech: the POS computer reads text in its own offline voice for the KDS display. Bad
 * requests are refused, and a language this computer cannot speak answers 204 so the display
 * stays quiet instead of failing.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/kds-speech.test.ts
 */
const express = require('express');
const { startServer, assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const http = require('http');
const { handleKdsSpeech, handleKdsSpeechEngine } = require('../main/services/kds-speech');

async function main() {
  console.log('KDS speech');
  console.log('='.repeat(60));
  const app = express();
  app.use(express.json());
  app.get('/speech', handleKdsSpeechEngine);
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
    // A local voice service (such as F5-TTS-THAI) speaks Thai first when FloCafe is started with it.
    const asked: string[] = [];
    let localFails = false;
    const local = http.createServer((req: any, res: any) => {
      let body = '';
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        asked.push(JSON.parse(body).text);
        if (localFails) {
          res.writeHead(500).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'audio/wav' }).end('RIFF-local-voice');
      });
    });
    await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
    const engine = async () => (await (await fetch(`${baseUrl}/speech`)).json()).engine;
    assertEqualOrThrow(await engine(), 'system', 'without a local voice the computer voice is used');
    process.env.FLO_KDS_TTS_URL = `http://127.0.0.1:${local.address().port}/`;
    try {
      assertEqualOrThrow(await engine(), 'local', 'displays learn the POS computer has its own voice');
      const spoken = await speak({ text: 'โต๊ะ 9 พร้อมเสิร์ฟ', lang: 'th-TH' });
      assertEqualOrThrow(Buffer.from(await spoken.arrayBuffer()).toString(), 'RIFF-local-voice', 'Thai is read by the local voice');
      assertEqualOrThrow(asked.join('|'), 'โต๊ะ 9 พร้อมเสิร์ฟ', 'the local voice gets the text');
      await speak({ text: 'hello', lang: 'en-US' });
      assertEqualOrThrow(asked.length, 1, 'other languages skip the Thai-only local voice');
      localFails = true;
      const fallback = await speak({ text: 'โต๊ะ 9 พร้อมเสิร์ฟ', lang: 'th-TH' });
      assertOrThrow(fallback.status === 204 || Buffer.from(await fallback.arrayBuffer()).subarray(0, 4).toString() === 'RIFF', 'a failing local voice falls back to the computer voice');
    } finally {
      delete process.env.FLO_KDS_TTS_URL;
      local.close();
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
