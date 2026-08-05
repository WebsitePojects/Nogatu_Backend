'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Rank incentives are handed over as PHYSICAL CASH outside this system. If
// `processIncentive` also credits the e-wallet, the member is paid twice — once
// in hand, once as an encashable balance. These tests pin the fail-closed gate
// so a future edit cannot silently re-open that path.

const ROOT = path.join(__dirname, '..', '..');
const rankingSrc = fs.readFileSync(path.join(ROOT, 'services', 'ranking.js'), 'utf8');

function processIncentiveBody(src) {
  const start = src.indexOf('async function processIncentive');
  assert.ok(start > -1, 'processIncentive must exist in services/ranking.js');
  const end = src.indexOf('\nmodule.exports', start);
  return src.slice(start, end > -1 ? end : src.length);
}

// ── The gate itself must be strict-equality opt-in, never truthy ──
test('wallet crediting is opt-in via strict === true (fail closed)', () => {
  const body = processIncentiveBody(rankingSrc);
  assert.match(body, /options\.creditWallet === true/,
    'creditWallet must be checked with === true so no truthy value (1, "false", {}) can open it');
  assert.ok(!/options\.creditWallet\s*\)/.test(body),
    'creditWallet must never be used as a bare truthy check');
});

// ── Every money write must sit INSIDE the gated block ──
test('all wallet writes are gated behind walletCredited', () => {
  const body = processIncentiveBody(rankingSrc);
  const gateAt = body.indexOf('if (walletCredited) {');
  assert.ok(gateAt > -1, 'processIncentive must gate its money block on walletCredited');

  for (const moneyWrite of ['payouthistorytab', 'payouttotaltab', 'ttlincome6', 'ttlcashbalance']) {
    const at = body.indexOf(moneyWrite);
    assert.ok(at > -1, `expected ${moneyWrite} to still be present (gated, not deleted)`);
    assert.ok(at > gateAt,
      `${moneyWrite} is written BEFORE the walletCredited gate — it would credit unconditionally`);
  }
});

// ── No caller may pass the flag ──
test('no route passes creditWallet', () => {
  const routesDir = path.join(ROOT, 'routes');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('creditWallet')) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  })(routesDir);
  assert.deepStrictEqual(offenders, [],
    `these routes pass creditWallet and would double-pay on top of the cash handover: ${offenders.join(', ')}`);
});

// ── The fulfillment transition must be a compare-and-swap, not a blind UPDATE ──
test('fulfillment UPDATE re-asserts pending_fulfillment and checks affectedRows', () => {
  const body = processIncentiveBody(rankingSrc);
  assert.match(body, /UPDATE rank_achievementstab[\s\S]*?WHERE achievement_uid = \? AND status = 'pending_fulfillment'/,
    "the fulfillment UPDATE must re-assert status = 'pending_fulfillment' in its WHERE (CAS)");
  assert.match(body, /affectedRows !== 1/,
    'the handler must fail closed when the CAS claims no row (already fulfilled)');
});

// ── Mirror of the gate expression: only an explicit boolean true opens it ──
test('gate expression rejects every non-true value', () => {
  const gate = (options = {}) => options.creditWallet === true;
  for (const value of [undefined, null, 0, 1, '', 'true', 'false', {}, [], NaN]) {
    assert.strictEqual(gate({ creditWallet: value }), false,
      `creditWallet=${JSON.stringify(value)} must NOT open wallet crediting`);
  }
  assert.strictEqual(gate({}), false, 'absent creditWallet must not open wallet crediting');
  assert.strictEqual(gate({ creditWallet: true }), true, 'explicit true is the only opener');
});
