'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFakeDb } = require('./_arFakeDb');

const repoRoot = path.resolve(__dirname, '..', '..');
const pricing = require(path.join(repoRoot, 'services', 'ar', 'arPricing.js'));

// ── Fixtures ────────────────────────────────────────────────────────────────
// Binary tree: 1 (root) -> 10 leader1 -> 11 down1 -> 12 down2 ; 1 -> 20 other (outside leader1's leg)
const MEMBERS = [
  { uid: 1, username: 'root', firstname: 'Root', lastname: 'Node', refid: 0 },
  { uid: 10, username: 'leader1', firstname: 'Lea', lastname: 'Der', refid: 1 },
  { uid: 11, username: 'down1', firstname: 'Down', lastname: 'One', refid: 10 },
  { uid: 12, username: 'down2', firstname: 'Down', lastname: 'Two', refid: 11 },
  { uid: 20, username: 'other', firstname: 'Oth', lastname: 'Er', refid: 1 },
];
const ACCESS = [
  { id: 1, username: 'nogatuadmin', rights: 1, ar_center_id: null },
  { id: 2, username: 'ryanbere', rights: 2, ar_center_id: 1 },
  { id: 3, username: 'unbound', rights: 2, ar_center_id: null },
  { id: 4, username: 'jedlopez', rights: 2, ar_center_id: 2 },
];
const PRICES = [
  { producttype: 30, item_name: 'Gold', member_price: 10000, stockist_price: 10000, srp: 10000, active: 1 },
  { producttype: 60, item_name: 'Diamond', member_price: 150000, stockist_price: 150000, srp: 150000, active: 1 },
  { producttype: 100, item_name: 'Nogatu Barley Juice', member_price: 850, stockist_price: 720, srp: 1215, active: 1 },
  { producttype: 101, item_name: 'Nogatu Glow', member_price: 0, stockist_price: 490, srp: 830, active: 1 },
  { producttype: 102, item_name: 'Retired item', member_price: 500, stockist_price: 420, srp: 715, active: 0 },
];
const DISCOUNTS = [
  { stockist_type: 4, producttype: 30, peso_discount: 500 },
  { stockist_type: 4, producttype: 60, peso_discount: 4000 },
  { stockist_type: 2, producttype: 30, peso_discount: 20000 }, // absurd on purpose: must clamp at the unit price
];
const SUPER = { adminNumericId: 1, adminid: 'nogatuadmin', adminrights: 1 };
const CASHIER = { adminNumericId: 2, adminid: 'ryanbere', adminrights: 2 };
const UNBOUND = { adminNumericId: 3, adminid: 'unbound', adminrights: 2 };
const OTHER_CASHIER = { adminNumericId: 4, adminid: 'jedlopez', adminrights: 2 };

function setup(overrides = {}) {
  const { db, pool, hooks } = createFakeDb({
    members: MEMBERS, access: ACCESS, prices: PRICES, discounts: DISCOUNTS,
    stockists: [{ uid: 10, stockist_type: 4 }], ...overrides,
  });
  const dbPath = path.join(repoRoot, 'config', 'database.js');
  const reload = [path.join(repoRoot, 'services', 'codeGeneration.js'),
    ...['arReceipts', 'arNetwork', 'arPricing'].map((f) => path.join(repoRoot, 'services', 'ar', `${f}.js`))];
  reload.forEach((p) => delete require.cache[p]);
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool } };
  try {
    return { db, hooks, receipts: require(path.join(repoRoot, 'services', 'ar', 'arReceipts.js')) };
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
  }
}

const packageAr = (extra = {}) => ({
  mode: 'package', buyerUsername: 'leader1', items: [{ producttype: 30, qty: 2 }], paymentMethod: 'cash', ...extra,
});
const rejectsWith = (code) => (err) => { assert.equal(err.code, code, err.message); return true; };
// Every create carries a fresh per-intent key, as the UI sends one.
let keyCounter = 0;
const nextKey = () => `test-intent-${String(++keyCounter).padStart(4, '0')}`;
const createAr = (receipts, session, body) => receipts.createReceipt(session, body, nextKey());

// ── Pricing (pure) ──────────────────────────────────────────────────────────
const priceMap = new Map(PRICES.map((p) => [p.producttype, p]));
const discountMap = new Map(DISCOUNTS.map((d) => [`${d.stockist_type}:${d.producttype}`, d.peso_discount]));

test('packages: a Provincial stockist gets Dino\'s peso discount per package', () => {
  const r = pricing.priceReceipt({ mode: 'package', items: [{ producttype: 30, qty: 2 }], priceList: priceMap, discounts: discountMap, stockistType: 4 });
  assert.equal(r.subtotal, 20000);
  assert.equal(r.discount_total, 1000);
  assert.equal(r.total, 19000);
  assert.equal(r.lines[0].discount_each, 500);
});

test('no stacking: a stockist buying PRODUCTS at member price gets no package discount', () => {
  // Even if a product row somehow reached the discount table, cash modes must ignore it.
  const withProductRow = new Map([...discountMap, ['4:100', 100]]);
  const r = pricing.priceReceipt({ mode: 'cash_member', items: [{ producttype: 100, qty: 3 }], priceList: priceMap, discounts: withProductRow, stockistType: 4 });
  assert.equal(r.discount_total, 0);
  assert.equal(r.total, 2550);
});

test('client-sent prices are ignored: the server price list decides', () => {
  const r = pricing.priceReceipt({ mode: 'cash_srp', items: [{ producttype: 100, qty: 1, unit_price: 1, line_total: 1 }], priceList: priceMap, discounts: discountMap });
  assert.equal(r.total, 1215);
});

test('a discount larger than the price is clamped, never producing a negative line', () => {
  const r = pricing.priceReceipt({ mode: 'package', items: [{ producttype: 30, qty: 1 }], priceList: priceMap, discounts: discountMap, stockistType: 2 });
  assert.equal(r.lines[0].discount_each, 10000);
  assert.equal(r.total, 0);
});

test('missing, zero or inactive prices are refused rather than sold for free', () => {
  const go = (pt, mode = 'cash_member') => () => pricing.priceReceipt({ mode, items: [{ producttype: pt, qty: 1 }], priceList: priceMap, discounts: discountMap });
  assert.throws(go(101), rejectsWith('AR_PRICE_MISSING'));   // member price 0
  assert.throws(go(102), rejectsWith('AR_PRICE_MISSING'));   // inactive
  assert.throws(go(105), rejectsWith('AR_PRICE_MISSING'));   // not on the list
});

test('item kind must match the mode; quantities are whole, positive and capped; lines merge', () => {
  const base = { priceList: priceMap, discounts: discountMap };
  assert.throws(() => pricing.priceReceipt({ ...base, mode: 'package', items: [{ producttype: 100, qty: 1 }] }), /not a package/);
  assert.throws(() => pricing.priceReceipt({ ...base, mode: 'cash_member', items: [{ producttype: 30, qty: 1 }] }), /not a product/);
  assert.throws(() => pricing.priceReceipt({ ...base, mode: 'cash_member', items: [{ producttype: 100, qty: 0 }] }), /at least 1/);
  assert.throws(() => pricing.priceReceipt({ ...base, mode: 'cash_member', items: [{ producttype: 100, qty: 1.5 }] }), /whole number/);
  assert.throws(() => pricing.priceReceipt({ ...base, mode: 'cash_member', items: [{ producttype: 100, qty: 501 }] }), /limited to 500/);
  const merged = pricing.priceReceipt({ ...base, mode: 'cash_member', items: [{ producttype: 100, qty: 1 }, { producttype: 100, qty: 2 }] });
  assert.equal(merged.lines.length, 1);
  assert.equal(merged.lines[0].qty, 3);
});

test('AR numbers are digits only; payment rules tie vouchers to voucher ARs; Manila year rolls at Manila midnight', () => {
  assert.equal(pricing.formatArNo(2026, 1236), '2026001236');
  assert.equal(pricing.isValidArNo('2026001236'), true);
  assert.equal(pricing.isValidArNo('AR-2026-1'), false);
  assert.throws(() => pricing.validatePayment('voucher', 'cash'), /paid by voucher/);
  assert.throws(() => pricing.validatePayment('cash_srp', 'voucher'), /Only a voucher AR/);
  assert.equal(pricing.manilaYear(Date.parse('2026-12-31T16:00:00Z')), 2027);
  assert.equal(pricing.manilaYear(Date.parse('2026-12-31T15:59:59Z')), 2026);
});

// ── Receipts: creation ──────────────────────────────────────────────────────
test('an unseeded sequence refuses every AR and writes nothing', async () => {
  const { db, receipts } = setup({ nextSeq: null });
  await assert.rejects(() => createAr(receipts, CASHIER, packageAr()), rejectsWith('AR_SEQUENCE_NOT_SEEDED'));
  assert.equal(db.receipts.length, 0);
});

test('a cashier not bound to a center cannot create an AR', async () => {
  const { db, receipts } = setup();
  await assert.rejects(() => createAr(receipts, UNBOUND, packageAr()), rejectsWith('AR_NO_CENTER'));
  assert.equal(db.receipts.length, 0);
});

test('a package AR is priced server-side, stamped with the cashier\'s center, numbered, and waits for approval', async () => {
  const { db, receipts } = setup();
  const out = await createAr(receipts, CASHIER, packageAr());
  assert.equal(out.status, 'pending_approval');
  assert.match(out.arNo, /^\d{4}001001$/);
  assert.equal(out.total, 19000);
  const r = db.receipts[0];
  assert.equal(r.center_id, 1);
  assert.equal(r.prepared_by, 'ryanbere');
  assert.equal(r.stockist_type, 4);
  assert.equal(db.seq.next_seq, 1002);
  assert.equal(db.codes.length, 0, 'no codes exist before approval');
});

test('network rule: codes may not go to someone outside the buyer\'s binary downline, and the number is not burned', async () => {
  const { db, receipts } = setup();
  await assert.rejects(
    () => createAr(receipts, CASHIER, packageAr({ recipientUsername: 'other' })),
    rejectsWith('AR_OUTSIDE_NETWORK')
  );
  assert.equal(db.receipts.length, 0);
  assert.equal(db.seq.next_seq, 1001, 'a refused AR must not consume a number');
});

test('network rule: a deep binary downline IS allowed', async () => {
  const { receipts } = setup();
  const out = await createAr(receipts, CASHIER, packageAr({ recipientUsername: 'down2' }));
  assert.equal(out.status, 'pending_approval');
});

test('an SRP walk-in sale completes immediately and never generates codes', async () => {
  const { db, receipts } = setup();
  const out = await createAr(receipts, CASHIER, { mode: 'cash_srp', buyerName: 'Juan', items: [{ producttype: 100, qty: 2 }], paymentMethod: 'gcash' });
  assert.equal(out.status, 'completed');
  assert.equal(out.total, 2430);
  assert.equal(db.items[0].generates_codes, 0);
  assert.equal(db.codes.length, 0);
});

test('stockist pricing requires the buyer to be a registered stockist', async () => {
  const { receipts } = setup();
  await assert.rejects(
    () => createAr(receipts, CASHIER, { mode: 'cash_stockist', buyerUsername: 'down1', items: [{ producttype: 100, qty: 1 }], paymentMethod: 'cash' }),
    rejectsWith('AR_NOT_STOCKIST')
  );
});

test('two cashiers creating at the same moment get two different AR numbers', async () => {
  const { db, receipts } = setup();
  const [a, b] = await Promise.all([
    createAr(receipts, CASHIER, packageAr()),
    createAr(receipts, OTHER_CASHIER, packageAr()),
  ]);
  assert.notEqual(a.arNo, b.arNo);
  assert.equal(db.receipts.length, 2);
  assert.equal(db.seq.next_seq, 1003);
});

// ── Receipts: approval and release ──────────────────────────────────────────
test('approval mints exactly qty codes, hands every one to the recipient, and completes the AR', async () => {
  const { db, receipts } = setup();
  const { id } = await createAr(receipts, CASHIER, packageAr({ recipientUsername: 'down1' }));
  const out = await receipts.approveReceipt(SUPER, id);
  assert.equal(out.codesReleased, 2);
  assert.equal(db.codes.length, 2);
  for (const c of db.codes) {
    assert.equal(c.uid, 11, 'owned by the recipient');
    assert.equal(c.codestatus, 1, 'released, not used');
  }
  assert.equal(db.links.length, 2);
  // Per code: 'generated' (minting, existing behaviour) + 'release' + 'admin_transfer' to the recipient.
  assert.deepEqual(db.events.map((e) => e.type).sort(), ['admin_transfer', 'admin_transfer', 'generated', 'generated', 'release', 'release']);
  assert.ok(db.events.filter((e) => e.type !== 'generated').every((e) => e.to === 11), 'release and transfer both name the recipient');
  assert.equal(db.receipts[0].status, 'completed');
  assert.equal(db.receipts[0].approved_by, 'nogatuadmin');
});

test('DOUBLE-FIRE (sequential): approving twice releases codes once', async () => {
  const { db, receipts } = setup();
  const { id } = await createAr(receipts, CASHIER, packageAr());
  await receipts.approveReceipt(SUPER, id);
  await assert.rejects(() => receipts.approveReceipt(SUPER, id), rejectsWith('AR_WRONG_STATUS'));
  assert.equal(db.codes.length, 2);
  assert.equal(db.links.length, 2);
});

test('DOUBLE-FIRE (concurrent): two simultaneous approvals release codes once', async () => {
  const { db, receipts } = setup();
  const { id } = await createAr(receipts, CASHIER, packageAr());
  const results = await Promise.allSettled([receipts.approveReceipt(SUPER, id), receipts.approveReceipt(SUPER, id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one approval wins');
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'AR_WRONG_STATUS');
  assert.equal(db.codes.length, 2);
  assert.equal(db.links.length, 2);
});

test('a failure mid-release rolls EVERYTHING back: no codes, no links, AR still pending, reason recorded', async () => {
  const { db, hooks, receipts } = setup();
  const { id } = await createAr(receipts, CASHIER, packageAr());
  hooks.failCodeCasOnce = true;
  await assert.rejects(() => receipts.approveReceipt(SUPER, id), rejectsWith('AR_RELEASE_CONFLICT'));
  assert.equal(db.codes.length, 0, 'minted codes rolled back');
  assert.equal(db.links.length, 0);
  assert.equal(db.receipts[0].status, 'pending_approval');
  assert.match(db.receipts[0].release_error, /could not be released/);
  // …and a clean retry then succeeds exactly once.
  await receipts.approveReceipt(SUPER, id);
  assert.equal(db.codes.length, 2);
});

test('only Super Admin can approve', async () => {
  const { db, receipts } = setup();
  const { id } = await createAr(receipts, CASHIER, packageAr());
  await assert.rejects(() => receipts.approveReceipt(CASHIER, id), rejectsWith('AR_FORBIDDEN'));
  assert.equal(db.codes.length, 0);
});

test('the network is re-checked at approval: a recipient moved out of the leg is refused', async () => {
  const { db, receipts } = setup();
  const { id } = await createAr(receipts, CASHIER, packageAr({ recipientUsername: 'down1' }));
  db.members.find((m) => m.uid === 11).refid = 20; // moved under 'other'
  await assert.rejects(() => receipts.approveReceipt(SUPER, id), rejectsWith('AR_OUTSIDE_NETWORK'));
  assert.equal(db.codes.length, 0);
});

// ── Void, legacy, sequence ──────────────────────────────────────────────────
test('void: a cashier may void only their own pending AR; only Super Admin may void a completed AR', async () => {
  const { db, receipts } = setup();
  const { id } = await createAr(receipts, CASHIER, packageAr());
  await assert.rejects(() => receipts.voidReceipt(OTHER_CASHIER, id, 'mistake'), rejectsWith('AR_WRONG_STATUS'));
  await assert.rejects(() => receipts.voidReceipt(CASHIER, id, '  '), /reason is required/);
  await receipts.voidReceipt(CASHIER, id, 'wrong buyer');
  assert.equal(db.receipts[0].status, 'void');
  await assert.rejects(() => receipts.approveReceipt(SUPER, id), rejectsWith('AR_WRONG_STATUS'));

  const done = await createAr(receipts, CASHIER, { mode: 'cash_srp', items: [{ producttype: 100, qty: 1 }], paymentMethod: 'cash' });
  await assert.rejects(() => receipts.voidReceipt(CASHIER, done.id, 'late'), rejectsWith('AR_WRONG_STATUS'));
  await receipts.voidReceipt(SUPER, done.id, 'delivered to the wrong branch');
  assert.equal(db.receipts.find((r) => r.id === done.id).status, 'void');
  await assert.rejects(() => receipts.voidReceipt(SUPER, done.id, 'again'), rejectsWith('AR_WRONG_STATUS'));
});

test('legacy ARs: digits only, no duplicates, never generate codes, and skip the live sequence', async () => {
  const { db, receipts } = setup();
  const body = { arNo: '4512', legacyDate: '2026-08-20', mode: 'package', centerId: 1,
    items: [{ producttype: 30, description: 'Gold', qty: 1, unitPrice: 9500 }] };
  await assert.rejects(() => receipts.createLegacyReceipt(SUPER, { ...body, arNo: 'AR4512' }), /digits only/);
  const out = await receipts.createLegacyReceipt(SUPER, body);
  assert.equal(out.status, 'completed');
  assert.equal(db.receipts[0].is_legacy, 1);
  assert.equal(db.receipts[0].total, 9500);
  assert.equal(db.codes.length, 0);
  assert.equal(db.seq.next_seq, 1001, 'legacy encoding does not touch the live sequence');
  await assert.rejects(() => receipts.createLegacyReceipt(SUPER, body), rejectsWith('AR_DUPLICATE_NUMBER'));
  await assert.rejects(() => receipts.createLegacyReceipt(CASHIER, { ...body, arNo: '4513' }), rejectsWith('AR_FORBIDDEN'));
});

test('the sequence can be seeded until the first live AR exists, then it is locked', async () => {
  const { db, receipts } = setup({ nextSeq: null });
  await receipts.seedSequence(SUPER, 4512);
  assert.equal(db.seq.next_seq, 4513);
  await createAr(receipts, CASHIER, packageAr());
  assert.match(db.receipts[0].ar_no, /^\d{4}004513$/);
  await assert.rejects(() => receipts.seedSequence(SUPER, 9000), rejectsWith('AR_SEQUENCE_LOCKED'));
  await assert.rejects(() => receipts.seedSequence(CASHIER, 1), rejectsWith('AR_FORBIDDEN'));
});

// ── Review fixes 2026-10-01 ─────────────────────────────────────────────────

test('create without a request key is refused and takes no AR number', async () => {
  const { db, receipts } = setup();
  for (const key of [undefined, '', 'short', 'has spaces in it!']) {
    await assert.rejects(() => receipts.createReceipt(CASHIER, packageAr(), key), rejectsWith('AR_KEY_REQUIRED'));
  }
  assert.equal(db.receipts.length, 0);
  assert.equal(db.seq.next_seq, 1001);
});

test('double tap: the same key twice returns the first AR and takes one number', async () => {
  const { db, receipts } = setup();
  const key = nextKey();
  const first = await receipts.createReceipt(CASHIER, packageAr(), key);
  const second = await receipts.createReceipt(CASHIER, packageAr(), key);
  assert.equal(second.id, first.id);
  assert.equal(second.arNo, first.arNo);
  assert.equal(second.replayed, true);
  assert.equal(db.receipts.length, 1);
  assert.equal(db.seq.next_seq, 1002);
});

test('double tap, concurrent: two in-flight requests with one key leave exactly one AR', async () => {
  const { db, receipts } = setup();
  const key = nextKey();
  const [a, b] = await Promise.all([
    receipts.createReceipt(CASHIER, packageAr(), key),
    receipts.createReceipt(CASHIER, packageAr(), key),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(db.receipts.length, 1);
  assert.equal(db.seq.next_seq, 1002, 'the losing attempt must give its number back');
});

test('different keys are different sales; the key is scoped to the admin who used it', async () => {
  const { db, receipts } = setup();
  const key = nextKey();
  await receipts.createReceipt(CASHIER, packageAr(), key);
  await receipts.createReceipt(CASHIER, packageAr(), nextKey());
  await receipts.createReceipt(OTHER_CASHIER, packageAr(), key);
  assert.equal(db.receipts.length, 3);
});

test('one AR may release at most 500 codes in total; non-code modes are not capped by it', () => {
  const big = { priceList: priceMap, discounts: discountMap };
  assert.throws(
    () => pricing.priceReceipt({ ...big, mode: 'package', items: [{ producttype: 30, qty: 300 }, { producttype: 60, qty: 201 }] }),
    /at most 500 codes/
  );
  const atCap = pricing.priceReceipt({ ...big, mode: 'package', items: [{ producttype: 30, qty: 300 }, { producttype: 60, qty: 200 }] });
  assert.equal(atCap.lines.reduce((s, l) => s + l.qty, 0), 500);
  const srp = pricing.priceReceipt({ ...big, mode: 'cash_srp', items: [{ producttype: 100, qty: 400 }, { producttype: 101, qty: 400 }] });
  assert.equal(srp.generatesCodes, false);
});

test('a member buyer is named from the member record, not from typed text', async () => {
  const { db, receipts } = setup();
  await receipts.createReceipt(CASHIER, packageAr({ buyerName: 'Somebody Else' }), nextKey());
  assert.equal(db.receipts[0].buyer_name, 'Lea Der');
  await receipts.createReceipt(CASHIER, { mode: 'cash_srp', buyerName: 'Juan', items: [{ producttype: 100, qty: 1 }], paymentMethod: 'cash' }, nextKey());
  assert.equal(db.receipts[1].buyer_name, 'Juan');
});

test('legacy AR: impossible dates and out-of-range amounts are refused', async () => {
  const { db, receipts } = setup();
  const body = { arNo: '4512', legacyDate: '2026-02-31', mode: 'cash_srp', centerId: 1, items: [{ description: 'Barley', qty: 1, unitPrice: 100 }] };
  await assert.rejects(() => receipts.createLegacyReceipt(SUPER, body), /real date/);
  const ok = { ...body, legacyDate: '2026-02-28' };
  await assert.rejects(() => receipts.createLegacyReceipt(SUPER, { ...ok, items: [{ description: 'x', qty: 100001, unitPrice: 1 }] }), /from 1 to 100000/);
  await assert.rejects(() => receipts.createLegacyReceipt(SUPER, { ...ok, items: [{ description: 'x', qty: 2, unitPrice: 9999999999 }] }), /receipt limit/);
  assert.equal(db.receipts.length, 0);
  await receipts.createLegacyReceipt(SUPER, ok);
  assert.equal(db.receipts.length, 1);
});

test('pricing: isRealIsoDate accepts real days only', () => {
  assert.equal(pricing.isRealIsoDate('2028-02-29'), true);
  for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '', null, '2026-02-31']) {
    assert.equal(pricing.isRealIsoDate(bad), false, String(bad));
  }
});

// ── Split orders (one Save -> consecutive ARs of at most 500 codes) ─────────

test('splitOrder fills each part to 500 before starting the next, and a product may span parts', () => {
  const parts = pricing.splitOrder([{ producttype: 30, qty: 750 }, { producttype: 60, qty: 300 }, { producttype: 30, qty: 50 }]);
  assert.deepEqual(parts.map((p) => p.reduce((s, l) => s + l.qty, 0)), [500, 500, 100]);
  assert.deepEqual(parts[0], [{ producttype: 30, qty: 500 }]);
  assert.deepEqual(parts[1], [{ producttype: 30, qty: 300 }, { producttype: 60, qty: 200 }]);
  assert.deepEqual(parts[2], [{ producttype: 60, qty: 100 }]);
  assert.deepEqual(pricing.splitOrder([{ producttype: 30, qty: 500 }]).length, 1);
  assert.throws(() => pricing.splitOrder([{ producttype: 30, qty: 5001 }]), /at most 5000 codes/);
  assert.throws(() => pricing.splitOrder([{ producttype: 30, qty: 1e15 }]), /at most 5000 codes/);
  assert.throws(() => pricing.splitOrder([{ producttype: 30, qty: 1.5 }]), /whole number/);
});

test('a split order is saved as consecutive numbered parts whose totals add up to the unsplit price', async () => {
  const { db, receipts } = setup();
  const out = await createAr(receipts, CASHIER, packageAr({ split: true, items: [{ producttype: 30, qty: 600 }, { producttype: 60, qty: 450 }] }));
  assert.equal(out.parts.length, 3);
  assert.deepEqual(db.receipts.map((r) => [r.ar_seq, r.split_part, r.split_count]), [[1001, 1, 3], [1002, 2, 3], [1003, 3, 3]]);
  assert.ok(db.receipts.every((r) => r.status === 'pending_approval' && r.split_group === db.receipts[0].split_group));
  assert.equal(db.receipts.filter((r) => r.client_key).length, 1, 'only part 1 carries the key');
  // leader1 is a Provincial stockist: Gold 10,000 - 500, Diamond 150,000 - 4,000.
  const expected = 600 * 9500 + 450 * 146000;
  assert.equal(out.groupTotal, expected);
  assert.equal(db.receipts.reduce((s, r) => s + r.total, 0), expected);
  for (const r of db.receipts) {
    const codes = db.items.filter((i) => i.ar_id === r.id).reduce((s, i) => s + i.qty, 0);
    assert.ok(codes <= 500, `part ${r.split_part} has ${codes} codes`);
  }
});

test('a split order is all-or-nothing: a refused part leaves no AR and no number taken', async () => {
  const { db, receipts } = setup();
  // Item 102 is inactive, so the LAST part fails pricing after earlier parts were priced.
  await assert.rejects(() => createAr(receipts, CASHIER, { mode: 'cash_member', buyerUsername: 'leader1', split: true,
    items: [{ producttype: 100, qty: 900 }, { producttype: 102, qty: 1 }], paymentMethod: 'cash' }), rejectsWith('AR_PRICE_MISSING'));
  assert.equal(db.receipts.length, 0);
  assert.equal(db.seq.next_seq, 1001);
});

test('without split: true an order above 500 codes is refused; non-code modes ignore split', async () => {
  const { db, receipts } = setup();
  await assert.rejects(() => createAr(receipts, CASHIER, packageAr({ items: [{ producttype: 30, qty: 501 }] })), /split order/);
  const srp = await createAr(receipts, CASHIER, { mode: 'cash_srp', split: true, items: [{ producttype: 100, qty: 3 }], paymentMethod: 'cash' });
  assert.equal(srp.parts.length, 1);
  assert.equal(db.receipts[0].split_group, null);
});

test('replaying a split order returns every part and creates nothing, sequential and concurrent', async () => {
  const { db, receipts } = setup();
  const body = packageAr({ split: true, items: [{ producttype: 30, qty: 700 }] });
  const key = nextKey();
  const [a, b] = await Promise.all([receipts.createReceipt(CASHIER, body, key), receipts.createReceipt(CASHIER, body, key)]);
  const c = await receipts.createReceipt(CASHIER, body, key);
  for (const r of [a, b, c]) assert.deepEqual(r.parts.map((p) => p.arNo), a.parts.map((p) => p.arNo));
  assert.equal(c.replayed, true);
  assert.equal(db.receipts.length, 2);
  assert.equal(db.seq.next_seq, 1003);
});

// ── Flags (cashier marks a completed AR; Super Admin voids or keeps) ─────────

async function completedSrp(receipts, session = CASHIER) {
  return createAr(receipts, session, { mode: 'cash_srp', buyerName: 'Juan', items: [{ producttype: 100, qty: 1 }], paymentMethod: 'cash' });
}

test('flag: a cashier flags a completed AR of their center; it changes nothing on the AR', async () => {
  const { db, receipts } = setup();
  const { id } = await completedSrp(receipts);
  const before = JSON.stringify(db.receipts[0]);
  await assert.rejects(() => receipts.flagReceipt(CASHIER, id, '  '), /Describe the mistake/);
  await assert.rejects(() => receipts.flagReceipt(OTHER_CASHIER, id, 'not mine'), rejectsWith('AR_NOT_FOUND'));
  const out = await receipts.flagReceipt(CASHIER, id, 'qty should have been 2');
  assert.equal(out.flagged, true);
  assert.equal(JSON.stringify(db.receipts[0]), before, 'flagging must not touch the AR');
  await assert.rejects(() => receipts.flagReceipt(SUPER, id, 'again'), rejectsWith('AR_ALREADY_FLAGGED'));
  assert.equal(db.flags.length, 1);
});

test('flag: a double tap leaves one open flag (concurrent)', async () => {
  const { db, receipts } = setup();
  const { id } = await completedSrp(receipts);
  const results = await Promise.allSettled([receipts.flagReceipt(CASHIER, id, 'x1'), receipts.flagReceipt(CASHIER, id, 'x1')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(db.flags.length, 1);
});

test('flag: pending or void ARs cannot be flagged (void the pending one instead)', async () => {
  const { receipts } = setup();
  const pending = await createAr(receipts, CASHIER, packageAr());
  await assert.rejects(() => receipts.flagReceipt(CASHIER, pending.id, 'oops'), rejectsWith('AR_WRONG_STATUS'));
  await receipts.voidReceipt(CASHIER, pending.id, 'oops');
  await assert.rejects(() => receipts.flagReceipt(SUPER, pending.id, 'oops'), rejectsWith('AR_WRONG_STATUS'));
});

test('resolve: Super Admin keeps a flagged AR (note required) and the AR is unchanged', async () => {
  const { db, receipts } = setup();
  const { id } = await completedSrp(receipts);
  await receipts.flagReceipt(CASHIER, id, 'typo in notes');
  await assert.rejects(() => receipts.resolveFlag(CASHIER, id, { resolution: 'kept', note: 'fine' }), rejectsWith('AR_FORBIDDEN'));
  await assert.rejects(() => receipts.resolveFlag(SUPER, id, { resolution: 'delete', note: 'x' }), /void the AR or keep it/);
  await assert.rejects(() => receipts.resolveFlag(SUPER, id, { resolution: 'kept', note: '' }), /Add a note/);
  const out = await receipts.resolveFlag(SUPER, id, { resolution: 'kept', note: 'typo only, amounts right' });
  assert.equal(out.status, 'completed');
  assert.equal(db.receipts[0].status, 'completed');
  assert.equal(db.flags[0].resolution, 'kept');
  assert.equal(db.flags[0].open_ar_id, null);
  await assert.rejects(() => receipts.resolveFlag(SUPER, id, { resolution: 'kept', note: 'again' }), rejectsWith('AR_NO_OPEN_FLAG'));
  // Resolved flags stay as history and a new mistake can be flagged.
  await receipts.flagReceipt(CASHIER, id, 'found another issue');
  assert.equal(db.flags.length, 2);
});

test('resolve: Super Admin voids a flagged AR; void and flag close together', async () => {
  const { db, receipts } = setup();
  const { id } = await completedSrp(receipts);
  await receipts.flagReceipt(CASHIER, id, 'charged twice');
  const out = await receipts.resolveFlag(SUPER, id, { resolution: 'voided', note: 'duplicate sale' });
  assert.equal(out.status, 'void');
  assert.equal(db.receipts[0].status, 'void');
  assert.equal(db.receipts[0].void_reason, 'duplicate sale');
  assert.equal(db.flags[0].resolution, 'voided');
});

test('resolve: a lost race (already void) rolls the flag resolution back too', async () => {
  const { db, receipts } = setup();
  const { id } = await completedSrp(receipts);
  await receipts.flagReceipt(CASHIER, id, 'charged twice');
  db.receipts[0].status = 'void'; // someone voided it a moment earlier without going through the flag
  await assert.rejects(() => receipts.resolveFlag(SUPER, id, { resolution: 'voided', note: 'dup' }), rejectsWith('AR_WRONG_STATUS'));
  assert.equal(db.flags[0].open_ar_id, id, 'flag must still be open after the rollback');
});

test('a plain Super Admin void also closes an open flag', async () => {
  const { db, receipts } = setup();
  const { id } = await completedSrp(receipts);
  await receipts.flagReceipt(CASHIER, id, 'wrong product');
  await receipts.voidReceipt(SUPER, id, 'wrong product sold');
  assert.equal(db.flags[0].resolution, 'voided');
  assert.equal(db.flags[0].open_ar_id, null);
});
