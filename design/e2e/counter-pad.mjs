/**
 * The prototype's counter can take an order.
 *
 * This is the third time the prototype has drifted from the app — the menu,
 * then the cart, now the order pad. Checked in a browser rather than assumed.
 *
 *   node design/e2e/counter-pad.mjs
 */
import { chromium } from 'playwright';
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await b.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.goto('file:///home/user/POS-restoran-suriani/design/prototype.html');

// Switch to the counter, the way a reviewer does.
await p.click('[data-surface="pos"]');
await p.waitForSelector('[data-device="pos"].is-live');

await p.waitForSelector('#padMenu .pad-row');
ok('the counter screen has an order pad');

const rows = await p.$$eval('#padMenu .pad-row', (e) => e.length);
if (rows < 100) fail(`the pad shows ${rows} dishes, expected the whole menu`);
ok(`the pad carries all ${rows} dishes`);

// Search, because 147 dishes is not something anyone scrolls mid-service.
await p.fill('#padSearch', 'kungfu');
await p.waitForFunction(() => document.querySelectorAll('#padMenu .pad-row').length < 10);
ok('the pad can be searched');
await p.fill('#padSearch', '');

// Add a dish; the pad reads it back.
await p.click('#padMenu .pad-row .pad-name');
await p.waitForSelector('#padCart .pad-line');
const cart = await p.textContent('#padCart');
if (!/RM/.test(cart)) fail('the pad cart shows no price');
ok('the pad reads the order back with its price');

const disabled = await p.getAttribute('#padSend', 'disabled');
if (disabled === null) fail('an unaimed pad could be sent');
ok('an unaimed pad cannot be sent');

// Aim at a table and send.
await p.click('#padTable');
await p.waitForSelector('#padTable[aria-pressed="true"]');
const aimed = await p.textContent('#padTable');
await p.click('#padSend');
await p.waitForFunction(() => !document.querySelector('#padCart .pad-line'));
ok(`sent to ${aimed.trim()} and the pad cleared`);

const printed = await p.textContent('#printer');
if (!/MEJA|M0/i.test(printed)) fail(`the kitchen did not get a docket: ${printed.slice(0, 80)}`);
ok('the kitchen printed it — same path as a phone order');

// Bungkus: not a table.
await p.click('#padMenu .pad-row .pad-name');
await p.click('#padBungkus');
await p.waitForSelector('#padBungkus[aria-pressed="true"]');
const send = await p.textContent('#padSend');
if (!/Bungkus/i.test(send)) fail(`bungkus not named on the send button: ${send}`);
ok('bungkus is a destination the pad can be aimed at');

// Language reaches the pad, placeholder included.
await p.click('#lang-en');
await p.waitForFunction(() => document.querySelector('#padBungkus').textContent.trim() === 'Takeaway');
const ph = await p.getAttribute('#padSearch', 'placeholder');
if (!/Search/i.test(ph ?? '')) fail(`the search placeholder stayed in Malay: ${ph}`);
ok('the language toggle reaches the pad, placeholder and all');

if (errors.length) fail('console errors: ' + errors.join(' | '));
ok('no console errors');
await b.close();
console.log('\nThe prototype counter takes orders.');
