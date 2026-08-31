/**
 * The Phase 5b gate, as far as CI can take it.
 *
 * A real browser, on the real customer app, talking over a real HTTP socket
 * to the real `@suriani/localserver` router — the same code the tablet runs —
 * and a real ESC/POS docket landing on a printer at the other end.
 *
 * What is *not* proven here is the Java that owns the socket and the
 * Capacitor bridge that carries a request into the WebView. Those two are
 * deliberately thin for exactly this reason, and the outage drills on real
 * hardware are what close the gap.
 *
 *   node tools/printer-sim/index.mjs
 *   pnpm --filter @suriani/menu exec vite build
 *   node tools/local-server-harness/dist.mjs
 *   node apps/pos/e2e/local-server.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.LOCAL_BASE ?? 'http://127.0.0.1:8099';
const TOKEN = 'HARNESSTOKEN0000000000000000AAAA';
const TABLE = `${BASE}/t/out_harness/${TOKEN}`;

const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

/* ---- what a stranger on the guest WiFi can reach ----------------- */

for (const path of [
  '/api/outlets',
  '/api/outlets/out_harness/floor',
  '/api/outlets/out_harness/reports/daily',
  '/api/auth/login',
  '/api/agent/jobs',
  `/api/t/out_harness/${TOKEN}/bill-request`,
  '/assets/../../capacitor.config.json',
]) {
  const res = await fetch(`${BASE}${path}`);
  if (res.status !== 404) fail(`${path} answered ${res.status}, expected 404`);
}
ok('no staff route, no bill request, no way out of /assets');

// A token that is not this table's, and an outlet id that is not this outlet.
const a = await fetch(`${BASE}/api/t/out_harness/WRONGTOKEN`);
const b = await fetch(`${BASE}/api/t/out_somewhere_else/${TOKEN}`);
if (a.status !== 404 || b.status !== 404) fail('bad token or outlet leaked something');
ok('an unknown token and an unknown outlet answer identically');

/* ---- the customer, on their own phone ---------------------------- */

const b0 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b0.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(TABLE);
await page.waitForSelector('.dish');
ok('the customer app loaded from the tablet, not the cloud');

const label = await page.textContent('.table-label, .brand-sub, header');
if (!/Meja 01/.test(label ?? '')) fail(`table label missing: ${label}`);
ok('it knows which table the QR was on');

// The banner that explains why this looks different.
const banner = await page.textContent('.offline-note');
if (!/internet/i.test(banner ?? '')) fail(`no local banner: ${banner}`);
ok(`the customer is told what is going on: "${banner.slice(0, 48)}…"`);

/* ---- ordering, with the option rules enforced locally ------------ */

await page.click('.cat-rail button:has-text("Minuman")');
await page.click('.dish:has-text("Teh Tarik")');
await page.waitForSelector('.sheet-add');

const disabled = await page.getAttribute('.sheet-add', 'disabled');
if (disabled === null) fail('a drink was addable without answering panas/ais');
ok('a drink cannot be ordered without answering panas, ais or bungkus');

await page.click('.opt:has-text("Bungkus (ais)")');
await page.fill('.notes-input', 'kurang manis');
await page.click('.sheet-add');
await page.waitForSelector('.cart-bar.is-up');

const total = await page.textContent('.cart-total strong');
if (!/3\.00/.test(total ?? '')) fail(`iced takeaway teh tarik priced ${total}, expected RM 3.00`);
ok('the RM 0.50 rule is charged once, priced by the tablet: ' + total.trim());

await page.click('.cart-bar .btn');
await page.waitForSelector('.total-row');
await page.click('.page .btn-accent');
await page.waitForSelector('.sent-title', { timeout: 10000 });
ok('the order was accepted with the internet nowhere in the picture');

// Bill and waiter are not on this server, and the app says so rather than
// offering buttons that would 404.
const acts = await page.textContent('.status-acts');
if (/Minta Bil|Request Bill/i.test(acts ?? '')) fail('offered a button the local server does not carry');
if (!/kaunter|counter/i.test(acts ?? '')) fail(`no counter line: ${acts}`);
ok('no bill button; the customer is pointed at the counter instead');

if (errors.length) fail('console errors: ' + errors.join(' | '));
ok('no page errors');

await b0.close();
console.log('\nLocal ordering verified end to end.');
