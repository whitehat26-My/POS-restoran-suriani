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
// The first tab is Nasi Ayam Hainan; teh tarik is the last section, and its
// hot/iced/takeaway choice is what the RM 0.50 rule rides on.
await cust.click('.cat-rail button:has-text("Minuman")');
await cust.click('.dish:has-text("Teh Tarik")');
await cust.click('.opt:has-text("Bungkus (ais)")');
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
//
// Across every ticket rather than the first one: the feed holds whatever else
// the shop did today, so asserting on `.ticket` alone made this pass or fail
// on the order of unrelated orders.
const tickets = await pos.$$eval('.ticket', (els) => els.map((e) => e.textContent));
tickets.some((t) => t.includes('Bungkus (ais)')) || fail('no ticket carries the modifier');
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
// Tolerant of a table that already asked, the same way the 86 toggle below
// is: this script is meant to survive being run twice against a database it
// has already touched. The card also re-renders on every twelve-second poll,
// so the click is given a stable locator and room to retry.
const askBill = cust.locator('.btn-card', { hasText: 'Minta Bil' }).first();
if (await askBill.count()) {
  await askBill.click({ timeout: 15000 });
}
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
billText.includes('Bungkus (ais)') || fail('bill missing modifier line');
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

// Settle it, which is how a bill ends now. Closing without payment is still
// there but it is the unusual path — a walkout, or a bill settled outside the
// system — and it says so on the button.
await pos.click('[data-testid="take-payment"]');
await pos.waitForSelector('[data-testid="payment"]');
await pos.click('[data-testid="tender-exact"]');
await pos.click('[data-testid="pay-confirm"]');
await pos.waitForSelector('.tbl[data-state="empty"][data-label="Meja 01"]', { timeout: 8000 });
ok('bill settled, table freed');

// --- 86 from the till ---
// 147 dishes: the counter finds one by typing, not by scrolling.
await pos.fill('[data-testid="menu-search"]', 'lamb');
await pos.waitForSelector('.mi:has-text("Lamb Chop")');
const filtered = await pos.$$eval('.mi', (rows) => rows.length);
filtered === 1 || fail(`menu search should leave one row, left ${filtered}`);
ok('menu search finds a dish among 147');

// Toggle rather than assert a fixed end state, so re-running this script
// against a database it already touched still means something.
const is86 = async (dish) =>
  (await pos.getAttribute(`.mi:has-text("${dish}")`, 'class')).includes('is-86');
const was86 = await is86('Lamb Chop');
await pos.click('.mi:has-text("Lamb Chop") .mi-86');
await pos.waitForSelector(
  was86 ? '.mi:not(.is-86):has-text("Lamb Chop")' : '.mi.is-86:has-text("Lamb Chop")',
);
ok(`Lamb Chop ${was86 ? 'un-86ed' : '86ed'} on the till`);
await pos.fill('[data-testid="menu-search"]', '');

// --- The owner's daily record ---
await pos.click('[data-testid="tab-records"]');
await pos.waitForSelector('[data-testid="day-list"] .day-row', { timeout: 5000 });
const dayText = await pos.textContent('[data-testid="day-list"]');
dayText.includes('RM') || fail('day list missing a sales figure');
await pos.waitForSelector('[data-testid="day-detail"] .stat-value', { timeout: 5000 });
const detailText = await pos.textContent('[data-testid="day-detail"]');
detailText.includes('Jualan') || fail('day detail missing the sales headline');
detailText.includes('Teh Tarik') || fail('day detail missing the dish sold');
ok("today's sale shows in the owner's daily record");

// Back to the counter. Rekod replaces the floor rather than sitting beside
// it, so everything below needs the till view back.
await pos.click('.pill:has-text("Kaunter")');
await pos.waitForSelector('[data-testid="menu-search"]');

// --- THE OUTAGE DRILL ---------------------------------------------------
// A staff token for asserting server state directly, independent of the UI.
const { token } = await (
  await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: OWNER_PHONE, pin: OWNER_PIN }),
  })
).json();
const hdr = { Authorization: `Bearer ${token}` };

// Cut the till's line, keep trading, restore it, and prove that every order
// landed exactly once. This is the whole offline promise, run for real.
// Start from a known state: the drill 86s Beef Steak with the line down and
// then asserts the server heard about it, so it must not be 86'd already.
await pos.fill('[data-testid="menu-search"]', 'Beef Steak');
await pos.waitForSelector('.mi:has-text("Beef Steak")');
if (await is86('Beef Steak')) {
  await pos.click('.mi:has-text("Beef Steak") .mi-86');
  await pos.waitForSelector('.mi:not(.is-86):has-text("Beef Steak")');
  await pos.waitForTimeout(800);
}
await pos.fill('[data-testid="menu-search"]', '');

await posCtx.setOffline(true);
ok('till taken offline');

// Two counter orders and an 86, with no line at all.
for (const dish of ['Chicken Chop', 'Fish and Chip']) {
  await pos.fill('[data-testid="menu-search"]', dish);
  await pos.click(`.mi:has-text("${dish}") .mi-name`);
  await pos.waitForSelector('.sheet');
  await pos.click('.sheet-foot .btn:has-text("Tambah")');
  await pos.click('.col .btn-accent:has-text("Hantar")');
  await pos.click('.veil .tbl >> nth=1');
  await pos.waitForSelector('.toast:has-text("direkod")', { timeout: 5000 });
}
await pos.fill('[data-testid="menu-search"]', 'Beef Steak');
await pos.click('.mi:has-text("Beef Steak") .mi-86');
await pos.waitForSelector('.mi.is-86:has-text("Beef Steak")');
ok('two counter orders and an 86 taken with the line down');

await pos.waitForSelector('[data-testid="outbox-pill"]', { timeout: 8000 });
const queued = await pos.textContent('[data-testid="outbox-pill"]');
/[1-9]/.test(queued) || fail(`outbox should show pending work, showed "${queued}"`);
ok(`till reports work waiting: ${queued.trim()}`);

// The server must have seen none of it.
const midOutage = await fetch(`${BASE}/api/outlets/${KB}/orders`, { headers: hdr });
const midCount = (await midOutage.json()).orders.length;

await posCtx.setOffline(false);
// No tap needed: the browser's own `online` event nudges the syncer, and the
// pill disappearing is the till saying the queue is empty.
await pos.waitForSelector('[data-testid="outbox-pill"]', { state: 'detached', timeout: 20000 });
ok('line restored, outbox drained by itself');

const after = await (await fetch(`${BASE}/api/outlets/${KB}/orders`, { headers: hdr })).json();
after.orders.length === midCount + 2 ||
  fail(`expected ${midCount + 2} orders after replay, found ${after.orders.length}`);
ok('both offline orders landed, exactly once');

// Drain again: a tablet that retries a batch it already sent must not double-bill.
await pos.reload();
await pos.waitForSelector('.tbl');
await pos.waitForTimeout(1500);
const settled = await (await fetch(`${BASE}/api/outlets/${KB}/orders`, { headers: hdr })).json();
settled.orders.length === midCount + 2 ||
  fail(`a reload double-billed: ${settled.orders.length} orders`);
ok('a reload replays nothing — no double billing');

// And the 86 survived the outage too.
const menuAfter = await (await fetch(`${BASE}/api/outlets/${KB}/menu`, { headers: hdr })).json();
const steak = menuAfter.items.find((i) => i.nameMs === 'Beef Steak');
steak && steak.isAvailable === 0 || fail('the offline 86 never reached the server');
ok('the 86 taken offline reached the server');

if (posErrors.length) fail('POS page errors: ' + posErrors.join('; '));
ok('no page errors');
await b.close();
console.log('ALL PASS');
