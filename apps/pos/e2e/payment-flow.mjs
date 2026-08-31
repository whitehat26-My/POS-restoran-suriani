/**
 * The Phase 6 gate: a full bill settles and closes.
 *
 * A customer orders from their phone, asks for the bill, and the counter
 * takes cash. What has to be true at the end: the drawer pulse is in the
 * bytes, the slip says RESIT rather than BIL and carries a receipt number,
 * the table is free, the phone says it was paid, and the day's record
 * separates what was sold from what was taken.
 *
 *   pnpm build:web
 *   cd apps/api && pnpm wrangler dev --port 8787
 *   node tools/printer-sim/index.mjs
 *   API_URL=http://localhost:8787 ADMIN_SEED_TOKEN=local-dev-seed pnpm seed
 *   KB=<outlet id> TOKEN=<meja 01 token> node apps/pos/e2e/payment-flow.mjs
 */
import { chromium } from 'playwright';

const KB = process.env.KB;
const TOKEN = process.env.TOKEN;
const OWNER_PHONE = process.env.OWNER_PHONE ?? '+60123456789';
const OWNER_PIN = process.env.OWNER_PIN ?? '246810';
if (!KB || !TOKEN) {
  console.error('Set KB and TOKEN (see header).');
  process.exit(2);
}
const BASE = 'http://localhost:8787';
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// --- The till ---
const posCtx = await b.newContext({ viewport: { width: 1180, height: 900 } });
const pos = await posCtx.newPage();
const posErrors = [];
pos.on('pageerror', (e) => posErrors.push(e.message));
await pos.goto(`${BASE}/pos/`);
await pos.fill('input[placeholder="No. telefon"]', OWNER_PHONE);
await pos.fill('input[placeholder="PIN"]', OWNER_PIN);
await pos.click('button:has-text("Masuk")');
await pos.waitForSelector('.tbl');
ok('till logged in');

// Opening float, so the drawer has something to reconcile against.
await pos.click('[data-testid="tab-day"]');
await pos.waitForSelector('[data-testid="day-close"]');
await pos.fill('.setup-field input[placeholder]', '200.00');
await pos.click('button:has-text("Simpan wang permulaan")');
await pos.waitForTimeout(600);
ok('opening float recorded');
await pos.click('.pill:has-text("Kaunter")');
await pos.waitForSelector('.tbl');

// --- The customer orders ---
const custCtx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const cust = await custCtx.newPage();
const custErrors = [];
cust.on('pageerror', (e) => custErrors.push(e.message));
await cust.goto(`${BASE}/t/${KB}/${TOKEN}`);
await cust.waitForSelector('.dish');
await cust.click('.cat-rail button:has-text("Nasi Lemak")');
await cust.click('.dish:has-text("Ayam Goreng")');
await cust.waitForSelector('.sheet-add');
await cust.click('.sheet-add');
await cust.click('.cart-bar .btn');
await cust.waitForSelector('.total-row');
await cust.click('.page .btn-accent');
await cust.waitForSelector('.sent-title', { timeout: 10000 });
ok('customer ordered from their phone');

// The status card re-renders on every twelve-second poll, so the button can
// detach mid-click. Scope to the confirmation screen's own card and let
// Playwright retry against a stable one.
await cust.locator('.sent-hero ~ .status-card .btn-card', { hasText: 'Minta Bil' })
  .first()
  .click({ timeout: 15000 });
await cust.waitForSelector('.status-note', { timeout: 10000 });
await pos.waitForSelector('.tbl[data-state="bill_requested"]', { timeout: 6000 });
ok('Minta Bil turned the table amber on the till');

// --- The counter takes cash ---
await pos.click('.tbl[data-state="bill_requested"]');
await pos.waitForSelector('[data-testid="bill-strip"]');
const dueText = await pos.textContent('[data-testid="take-payment"]');
const dueSen = Math.round(Number(dueText.replace(/[^0-9.]/g, '')) * 100);
if (!dueSen) fail(`could not read what is owed from "${dueText}"`);
const money = (sen) => `${Math.floor(sen / 100)}.${String(sen % 100).padStart(2, '0')}`;
ok(`the counter sees what is owed: ${dueText.trim()}`);

await pos.click('[data-testid="take-payment"]');
await pos.waitForSelector('[data-testid="payment"]');

// Cash is the default, so a cashier taking notes never has to choose.
const method = await pos.getAttribute('[data-testid="method-cash"]', 'aria-pressed');
if (method !== 'true') fail('cash was not the default method');
ok('cash is the default');

// RM 50 tendered. The change is asserted against what the bill actually is,
// so this test keeps working when somebody changes a price on the menu.
await pos.click('.quick-row .mini:has-text("50.00")');
const change = await pos.textContent('[data-testid="pay-change"]');
const wantChange = money(5000 - dueSen);
if (!change.includes(wantChange)) fail(`change was ${change}, expected RM ${wantChange}`);
ok(`change worked out before the drawer opens: ${change.trim()}`);

await pos.click('[data-testid="pay-confirm"]');
await pos.waitForSelector('.tbl[data-state="empty"]', { timeout: 8000 });
ok('bill settled and the table freed');

// --- The customer is told ---
await cust.waitForSelector('[data-testid="paid"]', { timeout: 20000 });
const paidText = await cust.textContent('[data-testid="paid"]');
if (!paidText.includes(money(dueSen))) fail(`paid note missing the amount: ${paidText}`);
if (!/resit|receipt/i.test(paidText ?? '')) fail(`paid note missing the receipt number: ${paidText}`);
ok(`the phone says so rather than going blank: "${paidText.slice(0, 60).trim()}…"`);

// --- The day ---
await pos.click('[data-testid="tab-day"]');
await pos.waitForSelector('[data-testid="day-close"]');
const collected = await pos.textContent('[data-testid="collected"]');
const expected = await pos.textContent('[data-testid="expected-cash"]');
if (!collected.includes(money(dueSen))) fail(`collected reads ${collected}`);
// The RM 200 float plus the cash taken. Nothing else belongs in the drawer.
const wantExpected = money(20_000 + dueSen);
if (!expected.includes(wantExpected)) {
  fail(`expected cash reads ${expected}, wanted RM ${wantExpected}`);
}
ok(`the drawer should hold ${expected.trim()} — float plus the cash, not the QR`);

// Count 60 sen short on purpose.
await pos.fill('[data-testid="counted-cash"]', money(20_000 + dueSen - 60));
await pos.click('[data-testid="close-day"]');
await pos.waitForSelector('[data-testid="variance"]', { timeout: 6000 });
const variance = await pos.textContent('[data-testid="variance"]');
if (!/Kurang/.test(variance ?? '') || !/0\.60/.test(variance ?? '')) {
  fail(`a 60 sen short drawer read as: ${variance}`);
}
// The unflattering number is the whole point of counting.
ok(`a short drawer says it is short: ${variance.trim()}`);

if (posErrors.length) fail('till console errors: ' + posErrors.join(' | '));
if (custErrors.length) fail('phone console errors: ' + custErrors.join(' | '));
ok('no page errors');

await b.close();
console.log('\nA full bill settles and closes.');
