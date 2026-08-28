/**
 * Customer-flow end-to-end, against the real stack.
 *
 * Not part of the vitest suite: it needs a browser and a running server.
 *
 *   pnpm --filter @suriani/menu build
 *   cd apps/api && pnpm wrangler d1 migrations apply suriani-control --local
 *   echo 'ADMIN_SEED_TOKEN=local-dev-seed' > apps/api/.dev.vars
 *   pnpm wrangler dev --port 8787          # in apps/api
 *   API_URL=http://localhost:8787 ADMIN_SEED_TOKEN=local-dev-seed pnpm seed
 *   KB=<outlet id> BANGI=<outlet id> TOKEN=<meja 01 token> \
 *     node apps/menu/e2e/customer-flow.mjs
 *
 * Walks the whole customer path: printed URL serves the page, BM/EN toggle,
 * a required option blocks Add, cart survives reload, submit, server-side
 * pricing verified through the staff API, cross-outlet isolation re-proven,
 * and an offline reload still renders from the service worker.
 */
import { chromium } from 'playwright';

const KB = process.env.KB;
const BANGI = process.env.BANGI;
const TOKEN = process.env.TOKEN;
const OWNER_PHONE = process.env.OWNER_PHONE ?? '+60123456789';
const OWNER_PIN = process.env.OWNER_PIN ?? '246810';
if (!KB || !BANGI || !TOKEN) {
  console.error('Set KB, BANGI and TOKEN (see header for the full recipe).');
  process.exit(2);
}
const URL = `http://localhost:8787/t/${KB}/${TOKEN}`;
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));

// 1. The printed URL serves the app, not JSON
await p.goto(URL);
await p.waitForSelector('.shop');
(await p.textContent('.shop')).includes('Suriani Kampung Baru') || fail('shop name');
(await p.textContent('.table-tag')).includes('Meja 01') || fail('table label');
ok('table URL serves the ordering page');

// 2. The eight categories the owner named, in her order
const rail = await p.$$eval('.cat-rail button', (bs) => bs.map((b) => b.textContent.trim()));
JSON.stringify(rail) === JSON.stringify([
  'Nasi Ayam Hainan', 'Nasi Lemak', 'Set Nasi Putih', 'Mee / Kuetiau / Bihun / Maggi',
  'Nasi Goreng', 'Western Food', 'Pasta', 'Side Dish', 'Indonesian Food',
  'Sarapan', 'Set Tambahan', 'Roti', 'Burger', 'Minuman',
]) || fail(`category rail: ${JSON.stringify(rail)}`);
ok('all fourteen sections render in the printed order');

// Rows drop the heading exactly as the printed card does.
await p.click('.cat-rail button:has-text("Nasi Goreng")');
const ngRows = await p.$$eval('.dish-name', (ns) => ns.map((n) => n.textContent.trim()));
ngRows.length === 26 || fail(`Nasi Goreng should list 26 dishes, listed ${ngRows.length}`);
ngRows.includes('Kampung') || fail(`no short "Kampung" row: ${ngRows.slice(0, 5)}`);
ngRows.some((n) => n.startsWith('Nasi Goreng')) && fail('rows still repeat the heading');
ok('26 nasi goreng, listed short under the heading');

// A category with no dishes yet says so rather than looking broken.
await p.click('.cat-rail button:has-text("Burger")');
await p.waitForSelector('.empty-cat');
ok('an empty category explains itself');

// 3. Language toggle
await p.click('.cat-rail button:has-text("Western Food")');
await p.click('.lang-swap button:has-text("EN")');
await p.waitForSelector('.dish-name:has-text("Lamb Chop")');
ok('EN toggle swaps strings');
await p.click('.lang-swap button:has-text("BM")');

// 4. The menu's RM 0.50 rule, enforced in the UI as one choice, not two.
await p.click('.cat-rail button:has-text("Minuman")');
await p.click('.dish:has-text("Teh Tarik")');
await p.waitForSelector('.sheet');
if (await p.locator('.sheet-add').isEnabled()) fail('Add enabled before required choice');
await p.click('.opt:has-text("Bungkus (ais)")');
if (!(await p.locator('.sheet-add').isEnabled())) fail('Add still disabled after choice');
(await p.textContent('.sheet-add')).includes('3.00') ||
  fail('iced takeaway teh tarik should be RM 3.00 (2.50 + one 0.50), not RM 3.50');
await p.click('.sheet-add');
ok('iced + bungkus charges the 50 sen once, not twice');

// 5. The noodle section: pick the dish, the noodle, and goreng or sup.
await p.click('.cat-rail button:has-text("Mee / Kuetiau")');
await p.click('.dish:has-text("Kungfu")');
await p.waitForSelector('.sheet');
if (await p.locator('.sheet-add').isEnabled()) fail('Add enabled before both noodle choices');
await p.click('.opt:has-text("Kuetiau")');
if (await p.locator('.sheet-add').isEnabled()) fail('Add enabled with only one of two choices');
await p.click('.opt:has-text("Sup")');
if (!(await p.locator('.sheet-add').isEnabled())) fail('Add still disabled after both choices');
(await p.textContent('.sheet-add')).includes('10.00') || fail('the noodle choices must be free');
await p.fill('.notes-input', 'kurang pedas');
await p.click('.sheet-add');
ok('noodle and goreng-or-sup both required, both free');

// 6. A dish with no options at all still takes a request, by chip
await p.click('.cat-rail button:has-text("Roti")');
await p.click('.dish:has-text("Kosong")');
await p.waitForSelector('.request .notes-input');
await p.click('.chip:has-text("Kurang manis")');
const chipNote = await p.inputValue('.notes-input');
chipNote.includes('Kurang manis') || fail(`chip did not fill the note: ${chipNote}`);
await p.click('.sheet-add');
ok('a dish with no options still takes a request');

// 6b. The undo. Tapping the wrong dish is the commonest mistake on this
// screen, and the fix has to be one tap where it happened — not three taps
// inside a cart the customer has to think to open.
await p.click('.cat-rail button:has-text("Western Food")');
await p.click('.dish:has-text("Lamb Chop")');
await p.click('.sheet-add');
await p.waitForSelector('.undo-bar', { timeout: 3000 });
(await p.textContent('.undo-bar')).includes('Lamb Chop') || fail('undo bar does not name the dish');
const beforeUndo = await p.textContent('.cart-count');
await p.click('.undo-action');
await p.waitForSelector('.undo-bar', { state: 'detached', timeout: 3000 });
const afterUndo = await p.textContent('.cart-count');
Number(afterUndo) === Number(beforeUndo) - 1 ||
  fail(`undo did not remove the line: ${beforeUndo} → ${afterUndo}`);
ok('one tap undoes the dish just added');

// 6c. A wrong quantity is fixed without losing the options and the note.
await p.click('.cart-bar .btn');
await p.waitForSelector('.line-stepper');
const before = await p.textContent('.total-row .num');
await p.click('.line-item:has-text("Kungfu") .line-stepper button:has-text("+")');
await p.waitForFunction(
  (was) => document.querySelector('.total-row .num').textContent !== was,
  before,
);
(await p.textContent('.line-item:has-text("Kungfu")')).includes('Kuetiau') ||
  fail('changing the quantity lost the options');
await p.click('.line-item:has-text("Kungfu") .line-stepper button:has-text("−")');
await p.waitForFunction(
  (want) => document.querySelector('.total-row .num').textContent === want,
  before,
);
ok('quantity adjusts in the cart, keeping the options');
await p.click('.btn-ghost');

// 7. Cart survives a reload
await p.reload();
await p.waitForSelector('.cart-bar.is-up');
const total = await p.textContent('.cart-total strong');
total.includes('14.80') ||
  fail(`cart total after reload: ${total} (want RM 14.80 = 3.00 + 10.00 + 1.80)`);
ok('cart survives reload with correct total');

// 8. Submit
await p.click('.cart-bar .btn');
await p.waitForSelector('.total-row');
await p.click('.page .btn-accent');
await p.waitForSelector('.sent-title', { timeout: 10000 });
ok('order placed, confirmation shown');

// 9. Verify server side: order in KB, none in Bangi, total is the server's own maths
const login = await fetch('http://localhost:8787/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: OWNER_PHONE, pin: OWNER_PIN }),
});
const { token } = await login.json();
const hdr = { Authorization: `Bearer ${token}` };
const kb = await (await fetch(`http://localhost:8787/api/outlets/${KB}/orders`, { headers: hdr })).json();
const bg = await (await fetch(`http://localhost:8787/api/outlets/${BANGI}/orders`, { headers: hdr })).json();
kb.orders.length === 1 || fail(`KB should have 1 order, has ${kb.orders.length}`);
kb.orders[0].totalSen === 1480 || fail(`server total ${kb.orders[0].totalSen}, want 1480`);
bg.orders.length === 0 || fail('Bangi must have zero orders');
ok('order landed in the right outlet only; server priced RM 14.80 itself');

// The requests typed on the phone must survive into what the kitchen reads.
const notes = kb.orders[0].lines.flatMap((l) => (l.notes ? [l.notes] : []));
notes.some((n) => n.includes('kurang pedas')) || fail('typed request lost');
notes.some((n) => n.includes('Kurang manis')) || fail('chip request lost');
ok('both requests reached the server on the order lines');

// 10. Offline: SW should keep the page alive
await p.waitForTimeout(1500); // let the service worker settle
await ctx.setOffline(true);
await p.reload().catch(() => {});
try {
  await p.waitForSelector('.shop', { timeout: 5000 });
  ok('offline reload still renders the menu from the service worker');
} catch {
  fail('offline reload blanked the page');
}
await ctx.setOffline(false);

if (errors.length) fail('page errors: ' + errors.join('; '));
ok('no page errors');
await b.close();
console.log('ALL PASS');
