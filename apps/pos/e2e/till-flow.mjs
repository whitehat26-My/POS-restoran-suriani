/**
 * Till end-to-end, against the real stack. Needs a browser and a running
 * server — not part of the vitest suite.
 *
 *   pnpm build:web
 *   cd apps/api && pnpm wrangler d1 migrations apply suriani-control --local
 *   echo 'ADMIN_SEED_TOKEN=local-dev-seed' > apps/api/.dev.vars
 *   pnpm wrangler dev --port 8787        # in apps/api
 *   API_URL=http://localhost:8787 ADMIN_SEED_TOKEN=local-dev-seed pnpm seed
 *   KB=<outlet id> TOKEN=<meja 01 token> node apps/pos/e2e/till-flow.mjs
 *
 * Asserts THE PHASE 3 GATE: an order placed on a phone reaches the till in
 * under 1000 ms. Then serve → customer track advances via the status poll,
 * Minta Bil turns the table amber, the bill sheet reports how much food is on
 * the table and prints it, closing frees the table, 86-ing flips an item, and
 * the sale shows up in the owner's daily record.
 */
import { chromium } from 'playwright';

const KB = process.env.KB;
const TOKEN = process.env.TOKEN;
// Defaults match apps/api/scripts/seed.mjs. Self-referential fallbacks here
// used to throw a TDZ error the moment the env vars were left unset.
const OWNER_PHONE = process.env.OWNER_PHONE ?? '+60123456789';
const OWNER_PIN = process.env.OWNER_PIN ?? '246810';
if (!KB || !TOKEN) {
  console.error('Set KB and TOKEN (see header for the full recipe).');
  process.exit(2);
}
const BASE = 'http://localhost:8787';
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// --- The till: login, floor, live feed ---
const posCtx = await b.newContext({ viewport: { width: 1180, height: 800 } });
const pos = await posCtx.newPage();
const posErrors = [];
pos.on('pageerror', (e) => posErrors.push(e.message));
await pos.goto(`${BASE}/pos/`);
await pos.fill('input[placeholder="No. telefon"]', OWNER_PHONE);
await pos.fill('input[placeholder="PIN"]', OWNER_PIN);
await pos.click('button:has-text("Masuk")');
await pos.waitForSelector('.tbl');
ok('till logged in, floor rendered');
await pos.waitForSelector('.pill:has-text("Langsung")', { timeout: 8000 });
ok('websocket live');

// --- The customer: order from the phone ---
const custCtx = await b.newContext({ viewport: { width: 390, height: 844 } });
const cust = await custCtx.newPage();
await cust.goto(`${BASE}/t/${KB}/${TOKEN}`);
await cust.waitForSelector('.dish');
// Nasi Lemak has its own category now; the first tab is Nasi Campur.
await cust.click('.cat-rail button:has-text("Nasi Lemak")');
await cust.click('.dish:has-text("Nasi Lemak")');
await cust.click('.opt:has-text("Tambah telur")');
await cust.click('.sheet-add');
await cust.click('.cart-bar .btn');
await cust.waitForSelector('.total-row');

// THE GATE: phone → till in under a second.
const t0 = Date.now();
await cust.click('.page .btn-accent');
await pos.waitForSelector('.ticket:has-text("Meja 01")', { timeout: 5000 });
const elapsed = Date.now() - t0;
if (elapsed >= 1000) fail(`order took ${elapsed}ms to reach the till (gate: <1000ms)`);
ok(`order on the till in ${elapsed}ms (< 1000ms gate)`);

// Ticket carries the modifier line.
const ticket = await pos.textContent('.ticket');
ticket.includes('Tambah telur') || fail('ticket missing modifier');
ok('ticket shows the modifier');

// Table went blue with the running total.
await pos.waitForSelector('.tbl[data-state="ordering"][data-label="Meja 01"]');
ok('floor map shows Meja 01 ordering');

// --- Serve → customer track advances on its next poll ---
await pos.click('.ticket .mini-go');
await pos.waitForSelector('.tbl[data-state="eating"][data-label="Meja 01"]');
ok('served: table turns eating on the till');
await cust.waitForFunction(
  () => document.querySelectorAll('.track .done').length >= 3,
  { timeout: 20000 },
);
ok('customer track reached Dihidang via the status poll');

// --- Minta Bil rings the till amber ---
await cust.click('.btn-card:has-text("Minta Bil")');
await pos.waitForSelector('.tbl[data-state="bill_requested"][data-label="Meja 01"]', { timeout: 5000 });
ok('Minta Bil turned the table amber on the till');
await cust.waitForSelector('.status-note');
ok('customer sees bill-requested note');

// --- Panggil pelayan (on a fresh table state it coalesces per-table) ---
// (button replaced by note after bill; skip UI, hit endpoint semantics already unit-tested)

// --- Bill sheet: how much food, then print, then close ---
await pos.click('.tbl[data-label="Meja 01"]');
await pos.waitForSelector('[data-testid="bill"] .bill-total');
const billText = await pos.textContent('[data-testid="bill"]');
billText.includes('Tambah telur') || fail('bill missing modifier line');
ok('bill sheet shows lines and total');

const strip = await pos.textContent('[data-testid="bill-strip"]');
/\d/.test(strip) && strip.includes('hidangan') || fail('bill strip missing the dish count');
strip.includes('RM') || fail('bill strip missing the total');
ok('bill strip shows the dish count and the amount');

await pos.click('[data-testid="print-receipt"]');
await pos.waitForSelector('.toast', { timeout: 5000 });
const printToast = await pos.textContent('.toast');
printToast.includes('pencetak') || fail(`unexpected print toast: ${printToast}`);
ok('bill queued to the printer');

pos.on('dialog', (d) => d.accept());
await pos.click('button:has-text("Tutup bil")');
await pos.waitForSelector('.tbl[data-state="empty"][data-label="Meja 01"]', { timeout: 5000 });
ok('bill closed, table freed');

// --- 86 from the till ---
await pos.click('.mi:has-text("Milo Ais") .mi-86');
await pos.waitForSelector('.mi.is-86:has-text("Milo Ais")');
ok('Milo Ais 86ed on the till');

// --- The owner's daily record ---
await pos.click('[data-testid="tab-records"]');
await pos.waitForSelector('[data-testid="day-list"] .day-row', { timeout: 5000 });
const dayText = await pos.textContent('[data-testid="day-list"]');
dayText.includes('RM') || fail('day list missing a sales figure');
await pos.waitForSelector('[data-testid="day-detail"] .stat-value', { timeout: 5000 });
const detailText = await pos.textContent('[data-testid="day-detail"]');
detailText.includes('Jualan') || fail('day detail missing the sales headline');
detailText.includes('Nasi Lemak Ayam Berempah') || fail('day detail missing the dish sold');
ok("today's sale shows in the owner's daily record");

if (posErrors.length) fail('POS page errors: ' + posErrors.join('; '));
ok('no page errors');
await b.close();
console.log('ALL PASS');
