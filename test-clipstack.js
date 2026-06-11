const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  console.log('🚀 Launching ClipStack via Playwright...');
  const app = await electron.launch({
    args: [path.join(__dirname, 'main.js')],
    timeout: 15000,
  });

  const consoleLogs = [];
  const consoleErrors = [];

  app.on('console', (msg) => {
    const text = `[main:${msg.type()}] ${msg.text()}`;
    consoleLogs.push(text);
    console.log(text);
  });

  console.log('⏳ Waiting for first window...');
  const win = await app.firstWindow({ timeout: 10000 });

  win.on('console', (msg) => {
    const text = `[renderer:${msg.type()}] ${msg.text()}`;
    consoleLogs.push(text);
    if (msg.type() === 'error') consoleErrors.push(text);
    console.log(text);
  });

  win.on('pageerror', (err) => {
    const text = `[renderer:pageerror] ${err.message}\n${err.stack}`;
    consoleErrors.push(text);
    console.log(text);
  });

  await win.waitForLoadState('domcontentloaded');
  console.log('✅ DOM loaded');

  // Force show the window (it's hidden by default)
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.show();
  });

  // Wait a bit for renderer init
  await win.waitForTimeout(1500);

  // Check #feed exists
  const feedExists = await win.locator('#feed').count();
  console.log(`📋 #feed elements found: ${feedExists}`);

  // Initial item count
  const itemsBefore = await win.locator('#feed .card, #feed .item, #feed [data-key]').count();
  console.log(`📊 Items in feed BEFORE copy: ${itemsBefore}`);

  // Trigger a clipboard write from the main process
  const testText = `playwright-test-${Date.now()}`;
  console.log(`📝 Writing to clipboard: "${testText}"`);
  await app.evaluate(({ clipboard }, text) => {
    clipboard.writeText(text);
  }, testText);

  // Wait for poll cycle (POLL_MS=300, give it 2s)
  await win.waitForTimeout(2000);

  // Check items after
  const itemsAfter = await win.locator('#feed .card, #feed .item, #feed [data-key]').count();
  console.log(`📊 Items in feed AFTER copy: ${itemsAfter}`);

  // Check if our text appears anywhere in #feed
  const feedHtml = await win.locator('#feed').innerHTML().catch(() => '');
  const found = feedHtml.includes(testText);
  console.log(`🔍 Test text found in feed HTML: ${found}`);

  // Get items from store via main process
  const storeItems = await app.evaluate(() => {
    const Store = require('electron-store');
    const s = new Store({ name: 'clipboard' });
    const items = s.get('items') || [];
    return items.slice(0, 3).map(i => ({
      type: i.type,
      value: typeof i.value === 'string' ? i.value.slice(0, 80) : '(non-string)',
      ts: i.ts,
    }));
  });
  console.log('📦 Top 3 items in store:', JSON.stringify(storeItems, null, 2));

  console.log('\n========== SUMMARY ==========');
  console.log(`Renderer page errors: ${consoleErrors.length}`);
  if (consoleErrors.length > 0) {
    console.log('--- ERRORS ---');
    consoleErrors.forEach(e => console.log(e));
  }
  console.log(`Items before: ${itemsBefore}, after: ${itemsAfter}`);
  console.log(`Test text captured to store: ${storeItems.some(i => i.value && i.value.includes(testText))}`);
  console.log(`Test text rendered in UI: ${found}`);
  console.log('=============================\n');

  await app.close();
  process.exit(consoleErrors.length > 0 || !found ? 1 : 0);
})().catch((err) => {
  console.error('💥 Test failed:', err);
  process.exit(1);
});
