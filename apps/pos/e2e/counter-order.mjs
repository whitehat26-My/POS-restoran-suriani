/**
 * The counter takes the order.
 *
 * Customers here order to a person and the cashier keys it in, so this is the
 * till's main job rather than a fallback for a phone nobody wants to use.
 * Two paths: a table somebody is sitting at, and bungkus, which has no table
 * at all and is paid for before it is cooked.
 *
 *   pnpm build:web
 *   cd apps/api && pnpm wrangler dev --port 8787
 *   API_URL=http://localhost:8787 ADMIN_SEED_TOKEN=local-dev-seed pnpm seed
 *   node apps/pos/e2e/counter-order.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:8787';
const OWNER_PHONE = process.env.OWNER_PHONE ?? '+60123456789';
const OWNER_PIN = process.env.OWNER_PIN ?? '246810';
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const pos = await (await b.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
const errors = [];
pos.on('pageerror', (e) => errors.push(e.message));

await pos.goto(`${BASE}/pos/`);
await pos.fill('input[placeholder="No. telefon"]', OWNER_PHONE);
await pos.fill('input[placeholder="PIN"]', OWNER_PIN);
await pos.click('button:has-text("Masuk")');
await pos.waitForSelector('.tbl');
ok('till logged in');

// --- The pad has to be aimed before it can be sent ---
await pos.fill('[data-testid="menu-search"]', 'Kampung');
await pos.click('.mi:has-text("Kampung") .mi-name');
await pos.waitForSelector('[data-testid="pad-add"]');
await pos.click('[data-testid="pad-add"]');
await pos.waitForSelector('[data-testid="pad-cart"]');
ok('a dish keyed in at the counter shows in the pad');

// The cashier can read back what they keyed, not just a count.
const cartText = await pos.textContent('[data-testid="pad-cart"]');
if (!/Kampung/.test(cartText ?? '')) fail(`pad cart does not name the dish: ${cartText}`);
if (!/RM/.test(cartText ?? '')) fail('pad cart shows no price');
ok('the pad reads the order back, dish and price');

const sendDisabled = await pos.getAttribute('[data-testid="pad-send"]', 'disabled');
if (sendDisabled === null) fail('an unaimed pad let the order be sent');
ok('an unaimed pad cannot be sent');

// --- Aim at a table and send ---
await pos.click('[data-testid="pad-target"]');
await pos.waitForSelector('.sheet:has-text("meja mana")');
await pos.click('.sheet .tbl');
await pos.waitForSelector('[data-testid="pad-target"][aria-pressed="true"]');
const aimed = await pos.textContent('[data-testid="pad-target"]');
ok(`aimed at ${aimed.trim()}`);

await pos.click('[data-testid="pad-send"]');
await pos.waitForSelector('.tbl[data-state="ordering"]', { timeout: 8000 });
ok('order sent to the table and the floor map turned blue');

// The pad clears, so the next customer does not inherit the last one's food.
if ((await pos.$$('[data-testid="pad-cart"]')).length) fail('the pad kept the order after sending');
ok('the pad cleared itself');

// --- Bungkus: no table, paid before it is cooked ---
await pos.fill('[data-testid="menu-search"]', 'Kosong');
await pos.click('.mi:has-text("Kosong") .mi-name');
await pos.waitForSelector('[data-testid="pad-add"]');
await pos.click('[data-testid="pad-add"]');
await pos.click('[data-testid="pad-bungkus"]');
await pos.waitForSelector('[data-testid="pad-bungkus"][aria-pressed="true"]');
ok('aimed at bungkus, which is not a table');

await pos.click('[data-testid="pad-send"]');
// Paid for before it is cooked, so the bill opens with the amount on it.
await pos.waitForSelector('[data-testid="take-payment"]', { timeout: 10000 });
const payLabel = await pos.textContent('[data-testid="take-payment"]');
if (!/RM/.test(payLabel ?? '')) fail(`bungkus bill did not open with an amount: ${payLabel}`);
ok(`bungkus went straight to payment: ${payLabel.trim()}`);

await pos.click('[data-testid="take-payment"]');
await pos.waitForSelector('[data-testid="payment"]');
await pos.click('[data-testid="tender-exact"]');
await pos.click('[data-testid="pay-confirm"]');
await pos.waitForSelector('[data-testid="payment"]', { state: 'detached', timeout: 8000 });
ok('bungkus paid and closed');

// The takeaway row must not be sitting on the floor plan pretending to be a
// table somebody can be seated at.
const labels = await pos.$$eval('.tbl', (els) => els.map((e) => e.getAttribute('data-label')));
if (labels.some((l) => l === 'Bungkus')) fail('the takeaway row is on the floor plan');
ok('the takeaway row is a destination, not a table on the floor');

if (errors.length) fail('console errors: ' + errors.join(' | '));
ok('no page errors');

await b.close();
console.log('\nThe counter can take an order.');
