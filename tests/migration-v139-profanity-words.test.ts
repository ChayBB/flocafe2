/**
 * Migration v139: an empty customer display profanity word list. A fresh install gets it, an
 * upgrade from v138 adds it without touching other settings, and an existing list survives a re-run.
 * Also pins the word-list bounds and masking used by the paired display feed.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v139-fresh-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initDatabase,
  getDatabase,
  getCurrentSchemaVersion,
  MIGRATIONS,
  closeDatabase,
} = require('../main/db');
const {
  maskProfanity,
  parseProfanityWords,
  readStoredProfanityWords,
  suggestedProfanityWords,
  PROFANITY_WORDS_KEY,
} = require('../main/services/profanity-filter');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const storedWords = (db: any) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(PROFANITY_WORDS_KEY) as any)?.value;

function checkHelpers() {
  assertEqualOrThrow(
    JSON.stringify(parseProfanityWords([' Bad ', 'bad', '', 'คำหยาบ'])),
    JSON.stringify(['Bad', 'คำหยาบ']),
    'words are trimmed, blank lines dropped, duplicates folded case-insensitively',
  );
  assertEqualOrThrow(parseProfanityWords('bad'), null, 'a non-array is rejected');
  assertEqualOrThrow(parseProfanityWords([1]), null, 'a non-string entry is rejected');
  assertEqualOrThrow(
    parseProfanityWords(['x'.repeat(51)]),
    null,
    'a 51-character word is rejected',
  );
  assertEqualOrThrow(
    parseProfanityWords(Array.from({ length: 201 }, (_, i) => `w${i}`)),
    null,
    'more than 200 words are rejected',
  );
  assertEqualOrThrow(
    parseProfanityWords(Array.from({ length: 200 }, (_, i) => `w${i}`))?.length,
    200,
    '200 words are accepted',
  );
  assertEqualOrThrow(
    JSON.stringify(readStoredProfanityWords('not json')),
    '[]',
    'a corrupt stored value reads as an empty list',
  );
  for (const [text, word] of [
    ['เค้กชีส', 'ชี'],
    ['หมากฝรั่ง', 'หมา'],
    ['Pancake', 'cake'],
  ]) {
    assertEqualOrThrow(maskProfanity(text, [word]), text, `"${word}" leaves "${text}" alone`);
  }
  assertEqualOrThrow(
    maskProfanity('ข้าวผัดหมาแมว', ['หมา']),
    'ข้าวผัด***แมว',
    'a whole Thai word inside running text is masked',
  );
  assertEqualOrThrow(maskProfanity('เย็ดแม่', ['เย็ดแม่']), '***', 'a multi-word entry is masked');
  assertEqualOrThrow(
    maskProfanity('ร้านคำหยาบมาก', ['คำหยาบ']),
    'ร้าน***มาก',
    'Thai substring is masked',
  );
  assertEqualOrThrow(maskProfanity('BAD bad', ['bad']), '*** ***', 'matching is case-insensitive');
  assertEqualOrThrow(
    maskProfanity('a.c abc', ['.']),
    'a***c abc',
    'regex characters match literally',
  );
  assertEqualOrThrow(maskProfanity('Cafe', []), 'Cafe', 'an empty list leaves text unchanged');
  const suggested = suggestedProfanityWords();
  assertOrThrow(suggested.includes('ควาย'), 'thai-bad-words roots are suggested');
  assertOrThrow(suggested.includes('มึงตาย'), 'a root that starts like a prefix is kept');
  assertOrThrow(!suggested.includes('ไอ้ควาย'), 'prefix + root pairings are left out');
  assertOrThrow(
    parseProfanityWords(suggested)?.length === suggested.length,
    'every suggestion fits the saved word-list bounds',
  );
}

function main() {
  console.log('Migration v139: customer display profanity words');
  checkHelpers();
  const originalMigrations = MIGRATIONS.slice();
  const latest = originalMigrations[originalMigrations.length - 1].version;

  initDatabase();
  let db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'fresh database reaches the latest schema');
  assertEqualOrThrow(storedWords(db), '[]', 'fresh: the word list starts empty');
  closeDatabase();

  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v139-upgrade-'));
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((m: any) => m.version <= 138));
  initDatabase();
  db = getDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), 138, 'upgrade store starts at v138');
  assertEqualOrThrow(storedWords(db), undefined, 'v138 has no word list');
  db.prepare("UPDATE settings SET value = 'Legacy Cafe' WHERE key = 'business_name'").run();

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  assertEqualOrThrow(getCurrentSchemaVersion(), latest, 'upgrade reaches the latest schema');
  assertEqualOrThrow(storedWords(db), '[]', 'upgrade: the word list starts empty');
  assertEqualOrThrow(
    (db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get() as any)?.value,
    'Legacy Cafe',
    'other settings survive the upgrade',
  );

  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('["x"]', PROFANITY_WORDS_KEY);
  for (const migration of MIGRATIONS.filter((m: any) => m.version === 139)) migration.up();
  assertOrThrow(storedWords(db) === '["x"]', 'v139 re-run keeps an existing list');
  closeDatabase();
  console.log('  all migration v139 checks passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
