// Pairing carry reset (V052): on an ownership handover the previous owner's unmatched carry must
// never pay out, while pairing earned before the cutoff, the caps, and every other account are
// unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');

const pairingPath = require.resolve('../../services/income/pairing');
const databasePath = require.resolve('../../config/database');
const accountStatePath = require.resolve('../../services/accountState');
const binaryEligibilityPath = require.resolve('../../services/binaryEligibility');

const { totalPairingAmount, computeCarry, isCarryFlushActive } = require('../../services/income/pairing');

const PAST_NOW = new Date('2026-12-31T00:00:00Z');

function entry(day, points, codeid = 1) {
  return { uid: 0, points, date: `${day} 00:00:00`, codeid };
}

function run(left, right, accttype, carryFlushDay) {
  // getNumLevels only adds real dates to allDates.
  const dates = new Set([...left, ...right].map((e) => e.date).filter(Boolean));
  const totals = { totalleft: 0, totalpointsleft: 0, totalright: 0, totalpointsright: 0 };
  return totalPairingAmount(left, right, dates, accttype, totals, { carryFlushDay });
}

test('flush discards the carry left at the cutoff; pairing before it is unchanged', () => {
  const left = [entry('2026-11-10', 1000)];
  const right = [entry('2026-11-11', 250), entry('2026-11-20', 500)];

  const without = run(left, right, 60, null);
  const withReset = run(left, right, 60, '2026-11-20 00:00:00');

  assert.equal(without.totalPay, 750, 'control: old carry of 750 pairs with the new 500');
  assert.equal(withReset.totalPay, 250, 'only the 250 matched before the cutoff is paid');
  assert.equal(withReset.carryLeft, 0);
  assert.equal(withReset.carryRight, 500, 'post-cutoff points wait for a match as normal');
});

test('points after the cutoff pair normally against each other', () => {
  const left = [entry('2026-11-10', 5000), entry('2026-11-21', 1000)];
  const right = [entry('2026-11-22', 1500)];
  const r = run(left, right, 60, '2026-11-20 00:00:00');
  assert.equal(r.totalPay, 1000);
  assert.equal(r.carryRight, 500);
  assert.equal(r.carryLeft, 0);
});

test('weekly cap already used before the cutoff still applies in the same week', () => {
  // Bronze weekly cap 10,000. Week = Tue 2026-11-17 .. Mon 2026-11-23.
  const left = [entry('2026-11-17', 10000), entry('2026-11-18', 250), entry('2026-11-24', 250)];
  const right = [entry('2026-11-17', 10000), entry('2026-11-18', 250), entry('2026-11-24', 250)];
  const r = run(left, right, 10, '2026-11-18 00:00:00');
  // 11-17 pays the full 10,000 cap; 11-18 matches 250 but the week is capped; 11-24 is a new week.
  assert.equal(r.totalPay, 10250);
});

test('the reset never lowers pairing already earned (no stall of the monotonic credit)', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rnd = mulberry32(seed);
    const { left, right } = randomLegs(rnd);
    const days = [...new Set([...left, ...right].map((e) => e.date))].sort();
    const flushDay = days[Math.floor(rnd() * days.length)];
    const before = (es) => es.filter((e) => e.date < flushDay);
    const paidBeforeCutoff = run(before(left), before(right), 30, null).totalPay;
    const withReset = run(left, right, 30, flushDay);
    assert.ok(withReset.totalPay >= paidBeforeCutoff, `seed ${seed}`);
    assert.ok(withReset.totalPay <= run(left, right, 30, null).totalPay, `seed ${seed}: reset cannot pay more`);
  }
});

test('computeCarry equals the engine counters, with and without a reset', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rnd = mulberry32(seed);
    const { left, right } = randomLegs(rnd);
    const days = [...new Set([...left, ...right].map((e) => e.date))].sort();
    for (const flushDay of [null, days[Math.floor(rnd() * days.length)], '2026-12-30 00:00:00']) {
      const engine = run(left, right, 20, flushDay);
      const shown = computeCarry(left, right, flushDay, PAST_NOW);
      assert.equal(shown.carryLeft, engine.carryLeft, `seed ${seed} flush ${flushDay}`);
      assert.equal(shown.carryRight, engine.carryRight, `seed ${seed} flush ${flushDay}`);
    }
  }
});

test('a reset dated in the future is not active yet', () => {
  const now = new Date('2026-11-24T10:00:00Z');
  assert.equal(isCarryFlushActive('2026-11-24 00:00:00', now), true);
  assert.equal(isCarryFlushActive('2026-11-25 00:00:00', now), false);
  assert.equal(isCarryFlushActive(null, now), false);
  const left = [entry('2026-11-10', 1000)];
  assert.equal(computeCarry(left, [], '2026-11-25 00:00:00', now).carryLeft, 1000);
  assert.equal(computeCarry(left, [], '2026-11-24 00:00:00', now).carryLeft, 0);
});

test('undated entries never wait, like in the engine', () => {
  const left = [{ uid: 0, points: 500, date: null, codeid: 1 }, entry('2026-11-11', 250)];
  assert.equal(computeCarry(left, [], null, PAST_NOW).carryLeft, 250);
  assert.equal(run(left, [], 60, null).carryLeft, 250);
});

test('FS-style entries (codeid 2) never count toward the carry', () => {
  const left = [entry('2026-11-10', 1000, 2), entry('2026-11-11', 250, 1)];
  assert.equal(computeCarry(left, [], null, PAST_NOW).carryLeft, 250);
});

// ---- getPairing / getCarryFlushDay against a fake pool --------------------------------------

function loadPairing({ resetRows, resetError }) {
  for (const p of [pairingPath, databasePath, accountStatePath, binaryEligibilityPath]) delete require.cache[p];
  const tree = {
    100: [
      { uid: 201, refid: 100, position: 1, codeid: 1, accttype: 60, currentaccttype: 60, binarypoints: 1000, datereg: '2026-11-10 01:00:00' },
      { uid: 202, refid: 100, position: 2, codeid: 1, accttype: 60, currentaccttype: 60, binarypoints: 250, datereg: '2026-11-11 01:00:00' },
    ],
    202: [
      { uid: 203, refid: 202, position: 1, codeid: 1, accttype: 60, currentaccttype: 60, binarypoints: 500, datereg: '2026-11-20 01:00:00' },
    ],
  };
  require.cache[databasePath] = {
    exports: {
      pool: {
        query: async (sql, params) => {
          if (sql.includes('FROM pairing_carry_resettab')) {
            if (resetError) throw resetError;
            return [resetRows];
          }
          if (sql.includes('FROM usertab')) return [tree[Number(params[0])] || []];
          if (sql.includes('FROM upgradetab')) return [[]];
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    },
  };
  require.cache[accountStatePath] = {
    exports: {
      getEffectiveAccountState: async (uid, row) => row || { uid, accttype: 60, currentaccttype: 60, codeid: 1 },
      countsForPairingSource: (row) => Number(row.codeid) === 1,
    },
  };
  require.cache[binaryEligibilityPath] = {
    exports: { getBinaryPairingEligibility: async () => ({ canEarnPairing: true }) },
  };
  const mod = require(pairingPath);
  return mod;
}

test.after(() => {
  for (const p of [pairingPath, databasePath, accountStatePath, binaryEligibilityPath]) delete require.cache[p];
});

test('getPairing without a reset row is unchanged', async () => {
  const pairing = loadPairing({ resetRows: [] });
  const r = await pairing.getPairing(100, 60);
  assert.equal(r.totalPay, 750);
  assert.equal(r.carryFlushDay, null);
  assert.equal(r.carryLeft, 250);
});

test('getPairing with a reset row discards the carry and keeps pairing earned before it', async () => {
  const pairing = loadPairing({ resetRows: [{ flush_day: '2026-11-20' }] });
  const r = await pairing.getPairing(100, 60);
  assert.equal(r.totalPay, 250);
  assert.equal(r.carryFlushDay, '2026-11-20 00:00:00');
  assert.equal(r.carryLeft, 0);
  assert.equal(r.carryRight, 500);
  assert.equal(r.countedRight, 500, 'display counts only post-reset PV');
});

test('getCarryResetLegPoints returns null for accounts without a reset (display unchanged)', async () => {
  const pairing = loadPairing({ resetRows: [] });
  assert.equal(await pairing.getCarryResetLegPoints(100), null);
  const reset = loadPairing({ resetRows: [{ flush_day: '2026-11-20' }] });
  assert.deepEqual(await reset.getCarryResetLegPoints(100), {
    carryFlushDay: '2026-11-20 00:00:00',
    totalPointsLeft: 0,
    totalPointsRight: 500,
  });
});

test('missing table (migration not yet applied) means no reset; any other error fails loudly', async () => {
  const missing = Object.assign(new Error('no table'), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
  const pairing = loadPairing({ resetRows: [], resetError: missing });
  assert.equal(await pairing.getCarryFlushDay(100), null, 'default executor path (pool) is used');
  const broken = loadPairing({ resetRows: [], resetError: Object.assign(new Error('lost'), { code: 'PROTOCOL_CONNECTION_LOST' }) });
  await assert.rejects(() => broken.getPairing(100, 60), /lost/);
});

// ---- helpers ----------------------------------------------------------------------------------

function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLegs(rnd) {
  const values = [250, 500, 1000, 2500, 5000, 15000];
  const left = [];
  const right = [];
  const count = 2 + Math.floor(rnd() * 25);
  for (let i = 0; i < count; i += 1) {
    const day = `2026-${String(9 + Math.floor(rnd() * 3)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`;
    const e = entry(day, values[Math.floor(rnd() * values.length)], rnd() < 0.1 ? 2 : 1);
    (rnd() < 0.5 ? left : right).push(e);
  }
  return { left, right };
}
