/**
 * Catalog CSV downloads start with a UTF-8 BOM so Excel shows Thai text correctly,
 * and an import accepts a file that still carries the BOM.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/menu-csv-utf8-bom.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-menu-csv-bom-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { menuCsvRoutes } = require('../main/routes/menu-csv');

async function download(baseUrl: string, urlPath: string, headers: Record<string, string>) {
  const response = await (globalThis as any).fetch(baseUrl + urlPath, { headers });
  return {
    contentType: response.headers.get('content-type') as string,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

async function main() {
  console.log('Catalog CSV UTF-8 BOM');
  console.log('='.repeat(60));
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-th', 'เครื่องดื่ม');
  seedProduct(db, 'prod-th', 'cat-th', 'ชาชักร้อน', 45);
  const app = createApp({ '/api/menu/csv': menuCsvRoutes });
  const { baseUrl, server } = await startServer(app);

  try {
    for (const type of ['categories', 'products', 'addons']) {
      const file = await download(baseUrl, `/api/menu/csv/export/${type}`, authHeader);
      assertEqualOrThrow(
        Array.from(file.bytes.slice(0, 3)).join(','),
        '239,187,191',
        `${type} export starts with a UTF-8 BOM`,
      );
      assertOrThrow(/charset=utf-8/i.test(file.contentType), `${type} export declares UTF-8`);
    }
    const template = await download(baseUrl, '/api/menu/csv/template/products', authHeader);
    assertEqualOrThrow(Array.from(template.bytes.slice(0, 3)).join(','), '239,187,191', 'template starts with a BOM');

    const products = await download(baseUrl, '/api/menu/csv/export/products', authHeader);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(products.bytes);
    assertOrThrow(text.includes('ชาชักร้อน'), 'Thai product names survive in the export bytes');
    assertOrThrow(text.includes('เครื่องดื่ม'), 'Thai category names survive in the export bytes');

    const categories = await download(baseUrl, '/api/menu/csv/export/categories', authHeader);
    const categoryCsv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(categories.bytes);
    assertOrThrow(categoryCsv.charCodeAt(0) === 0xfeff, 'the BOM is the first character of the file');
    const imported = await api(baseUrl, '/api/menu/csv/import/categories', {
      method: 'POST',
      headers: authHeader,
      body: { csv: categoryCsv },
    });
    assertEqualOrThrow(imported.status, 200, `an export with its BOM imports cleanly (${JSON.stringify(imported.data).slice(0, 120)})`);
    console.log('\nAll catalog CSV BOM checks passed');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error: any) => {
  console.error(error);
  process.exit(1);
});
