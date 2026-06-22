const test = require('node:test');
const assert = require('node:assert/strict');
const { pairingWeekKey, totalPairingAmount } = require('../../services/income/pairing');

test('pairingWeekKey buckets Tue 00:00 -> Mon 23:59 (Manila comp-plan week), not ISO Mon-Sun', () => {
  // Jun 02 2026 is a Tuesday -> starts its own week. Jun 01 (Mon) belongs to the PRIOR (May 26) week.
  assert.equal(pairingWeekKey('2026-06-02'), '2026-06-02');           // Tue = week start
  assert.equal(pairingWeekKey('2026-06-01 00:00:00'), '2026-05-26');  // Mon -> previous Tue week
  assert.equal(pairingWeekKey('2026-06-03'), '2026-06-02');           // Wed
  assert.equal(pairingWeekKey('2026-06-07'), '2026-06-02');           // Sun (still same Tue week)
  assert.equal(pairingWeekKey('2026-06-08'), '2026-06-02');           // Mon = end of the Tue week
  assert.equal(pairingWeekKey('2026-06-09'), '2026-06-09');           // next Tue = new week
  assert.equal(pairingWeekKey('2026-05-26'), '2026-05-26');           // Tue
});

test('weekly cap is applied per Tue-Mon week: a Monday is grouped with the PRIOR Tuesday week', () => {
  // Silver caps (accttype 20): 20,000/wk, 80,000/mo. Build a left/right leg so the matched amount
  // each day is deterministic (equal points both legs on the same day => fully matched that day).
  const mk = (date, points) => ({ date: `${date} 00:00:00`, points, codeid: 1 });
  const days = [
    ['2026-05-26', 1500],  // Tue  (week 05-26)
    ['2026-06-01', 250],   // Mon  (still week 05-26 under the fix; ISO would push to 06-01 week)
    ['2026-06-02', 16250], // Tue  (week 06-02)
    ['2026-06-03', 15000], // Wed  (week 06-02)
    ['2026-06-07', 1000],  // Sun  (week 06-02)
  ];
  const left = [], right = [], allDates = new Set();
  for (const [d, p] of days) { left.push(mk(d, p)); right.push(mk(d, p)); allDates.add(`${d} 00:00:00`); }
  const totals = { totalleft: days.length, totalpointsleft: 0, totalright: days.length, totalpointsright: 0 };
  const res = totalPairingAmount(left, right, allDates, 20, totals);
  // Week 05-26 = 1500 + 250 = 1750 (under cap, fully paid). Week 06-02 = 32,250 -> capped to 20,000.
  // => 1750 + 20000 = 21,750. (Under the OLD ISO bug, Jun 01 would join the Jun-01 week with the
  //    big matches and an extra 250 would be sealed, paying only 21,500.)
  assert.equal(res.totalPay, 21750);
});
