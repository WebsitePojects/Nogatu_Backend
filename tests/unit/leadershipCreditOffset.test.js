'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Mirror of the EXACT engine expression in calculateAndStoreIncome.js:
//   newLeadership = max(0, engine - ttlincome3 + offset)
// plus the credit step: ttlincome3 += newLeadership.
function newLeadership(engine, ttlincome3, offset = 0) {
  return Math.max(0, engine - ttlincome3 + offset);
}

// ── No other member is affected: offset=0 reproduces the original monotonic guard exactly ──
test('offset 0 == original monotonic guard (no leak to other members)', () => {
  for (const [engine, paid] of [[1500, 1000], [1000, 1000], [800, 1000], [0, 0], [250, 0]]) {
    assert.strictEqual(newLeadership(engine, paid, 0), Math.max(0, engine - paid),
      `offset=0 must equal max(0, engine-ttlincome3) for engine=${engine} paid=${paid}`);
  }
});

// ── Lhee: stored 53,232.50, true 33,847.50, offset 19,385 ──
test('Lhee — no instant credit, idempotent, bounded, no negative', () => {
  const offset = 19385.0;
  let paid = 53232.5;

  // reset moment: engine == true entitlement -> ZERO credit
  assert.strictEqual(newLeadership(33847.5, paid, offset), 0);

  // forward growth to 40,000 -> credit once, ttlincome3 lands at engine+offset
  let credit = newLeadership(40000, paid, offset);
  assert.strictEqual(credit, 6152.5);
  paid += credit;
  assert.strictEqual(paid, 59385.0);
  assert.strictEqual(paid, 40000 + offset); // bounded: exactly offset above true

  // re-run same engine -> idempotent (no double credit)
  assert.strictEqual(newLeadership(40000, paid, offset), 0);

  // further growth to 60,000
  credit = newLeadership(60000, paid, offset);
  paid += credit;
  assert.strictEqual(paid, 60000 + offset); // still exactly offset above true, never more

  // engine DROPS (tree shrinks more) -> no credit, no negative
  assert.strictEqual(newLeadership(30000, paid, offset), 0);
});

// ── Elmer: stored 29,307.50, true 26,720.00, offset 2,587.50 ──
test('Elmer — no instant credit, idempotent, bounded', () => {
  const offset = 2587.5;
  let paid = 29307.5;

  assert.strictEqual(newLeadership(26720.0, paid, offset), 0); // reset: no instant credit

  const credit = newLeadership(35000, paid, offset);           // grow to 35,000
  paid += credit;
  assert.strictEqual(paid, 35000 + offset);                    // bounded
  assert.strictEqual(newLeadership(35000, paid, offset), 0);   // idempotent
});

// ── A member who is UNDER (not over) gets offset 0 from the setter -> normal earning ──
test('under-credited member -> setter computes offset 0 -> unchanged', () => {
  const stored = 1000, engine = 1500;
  const offset = Math.max(0, Number((stored - engine).toFixed(2))); // setter formula
  assert.strictEqual(offset, 0);
  assert.strictEqual(newLeadership(engine, stored, offset), 500); // earns normally
});
