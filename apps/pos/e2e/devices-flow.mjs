/**
 * The Peranti screen, in a real browser against the real stack.
 *
 *   pnpm build:web
 *   cd apps/api && pnpm wrangler dev --port 8787
 *   API_URL=http://localhost:8787 ADMIN_SEED_TOKEN=local-dev-seed pnpm seed
 *   node apps/pos/e2e/devices-flow.mjs
 *
 * A browser cannot open a socket to a printer, so the test print itself is
 * out of reach here — that is the tablet's job and the screen says so. What
 * this proves is everything around it: the stations come from the server, an
 * agent credential is minted and stored against the right branch, the printer
 * addresses survive a reload, and a failed print names its reason.
 *
 * The role gate is not tested here — it is server-side, and printing.test.ts
 * already asserts a cashier gets 403 from the registration route. Hiding the
 * tab is a courtesy; the 403 is the enforcement.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8787';
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1180, height: 900 } });
const pos = await ctx.newPage();
const errors = [];
pos.on('pageerror', (e) => errors.push(e.message));

await pos.goto(`${BASE}/pos/`);
await pos.fill('input[placeholder="No. telefon"]', '+60123456789');
await pos.fill('input[placeholder="PIN"]', '246810');
await pos.click('button:has-text("Masuk")');
await pos.waitForSelector('.tbl');
ok('till logged in');

await pos.click('[data-testid="tab-devices"]');
await pos.waitForSelector('[data-testid="devices"]');
ok('Peranti tab opens');

// The stations come from the outlet, not from a hardcoded list.
await pos.waitForSelector('.setup-station');
const stations = await pos.$$eval('.setup-station-head', (els) =>
  els.map((e) => e.textContent.trim()));
if (stations.length < 2) fail(`expected the seeded stations, got ${JSON.stringify(stations)}`);
ok(`stations from the server: ${stations.join(' · ')}`);

// A browser is told plainly why it cannot test a printer, rather than
// offering a button that fails for a reason nobody can see.
const warn = await pos.$eval('.setup-warn', (e) => e.textContent);
if (!/soket/i.test(warn)) fail(`expected the browser warning, got: ${warn}`);
ok('browser is told it cannot reach a printer');

// Register the agent — the credential the tablet prints with.
await pos.click('button:has-text("Daftar peranti ini")');
await pos.waitForSelector('.setup-token');
const token = await pos.$eval('.setup-token', (e) => e.textContent.trim());
if (!/^dev_[0-9A-Z]+\./.test(token)) fail(`unexpected token shape: ${token}`);
ok('agent registered, token shown once');

// It is stored, and it names the branch it belongs to.
const stored = await pos.evaluate(() => localStorage.getItem('suriani_agent'));
const agent = JSON.parse(stored);
if (agent.token !== token) fail('stored token does not match the one shown');
if (!/Jalan Imbi/.test(agent.outletName)) fail(`agent not tied to a branch: ${stored}`);
ok(`agent bound to ${agent.outletName}`);

// Printer addresses persist. They are per-tablet, so localStorage is the
// right place — but only if they actually survive a restart.
const lan = await pos.$$('.setup-station input.field');
await lan[0].fill('127.0.0.1:9100');
await pos.waitForTimeout(150);
await pos.reload();
await pos.click('[data-testid="tab-devices"]');
await pos.waitForSelector('.setup-station');
const after = await pos.$$eval('.setup-station input.field', (els) => els.map((e) => e.value));
if (after[0] !== '127.0.0.1:9100') fail(`address lost on reload: ${JSON.stringify(after)}`);
ok('printer address survives a reload');

// The test print button is here, and in a browser it fails with a reason.
await pos.click('.setup-station button:has-text("Uji cetak")');
await pos.waitForSelector('.setup-result', { timeout: 8000 });
const result = await pos.$eval('.setup-result', (e) => e.textContent);
if (!result.startsWith('❌')) fail(`a browser should not be able to print: ${result}`);
ok(`test print reports why it failed: ${result.slice(0, 70)}`);

if (errors.length) fail('console errors: ' + errors.join(' | '));
ok('no page errors');

await b.close();
console.log('\nPeranti screen verified.');
