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
  'Nasi Campur', 'Nasi Lemak', 'Nasi Goreng', 'Mee / Bihun',
  'Roti', 'Burger', 'Western', 'Minuman',
]) || fail(`category rail: ${JSON.stringify(rail)}`);
ok('the eight categories render in order');

// A category with no dishes yet says so rather than looking broken.
await p.click('.cat-rail button:has-text("Burger")');
await p.waitForSelector('.empty-cat');
ok('an empty category explains itself');

// 3. Language toggle
await p.click('.cat-rail button:has-text("Nasi Lemak")');
await p.click('.lang-swap button:has-text("EN")');
await p.waitForSelector('.dish-name:has-text("Nasi Lemak with Spiced Chicken")');
ok('EN toggle swaps strings');
await p.click('.lang-swap button:has-text("BM")');

// 4. Required modifier blocks Add until chosen (Teh Tarik, min_select 1)
await p.click('.cat-rail button:has-text("Minuman")');
await p.click('.dish:has-text("Teh Tarik")');
await p.waitForSelector('.sheet');
if (await p.locator('.sheet-add').isEnabled()) fail('Add enabled before required choice');
await p.click('.opt:has-text("Ais")');
if (!(await p.locator('.sheet-add').isEnabled())) fail('Add still disabled after choice');
(await p.textContent('.sheet-add')).includes('3.50') || fail('sheet price should be RM 3.50 (3.00 + 0.50 ais)');
await p.click('.sheet-add');
ok('required option enforced in UI, priced +ais');

// 5. Nasi lemak with tambah telur, and a request typed by hand
await p.click('.cat-rail button:has-text("Nasi Lemak")');
await p.click('.dish:has-text("Nasi Lemak")');
await p.click('.opt:has-text("Tambah telur")');
await p.fill('.notes-input', 'kurang pedas');
await p.click('.sheet-add');
ok('extras added with a request');

// 6. A dish with no options at all still takes a request, by chip
await p.click('.cat-rail button:has-text("Minuman")');
await p.click('.dish:has-text("Kopi O Ais")');
await p.waitForSelector('.request .notes-input');
await p.click('.chip:has-text("Kurang manis")');
const chipNote = await p.inputValue('.notes-input');
chipNote.includes('Kurang manis') || fail(`chip did not fill the note: ${chipNote}`);
await p.click('.sheet-add');
ok('a dish with no options still takes a request');

// 7. Cart survives a reload
await p.reload();
await p.waitForSelector('.cart-bar.is-up');
const total = await p.textContent('.cart-total strong');
total.includes('20.20') ||
  fail(`cart total after reload: ${total} (want RM 20.20 = 3.50 + 13.50 + 3.20)`);
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
kb.orders[0].totalSen === 2020 || fail(`server total ${kb.orders[0].totalSen}, want 2020`);
bg.orders.length === 0 || fail('Bangi must have zero orders');
ok('order landed in the right outlet only; server priced RM 20.20 itself');

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
