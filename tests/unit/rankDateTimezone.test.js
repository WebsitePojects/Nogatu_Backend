/**
 * rank_date timezone regression (found 2026-08-27, uid 6499134 / Eunicetop01).
 *
 * services/ranking.js toMysqlDateTime() formatted with date.toISOString() (UTC) values
 * that mysql2 had parsed in the SERVER's local zone (Manila, UTC+8). Every DB -> JS -> DB
 * round-trip therefore lost 8h. rank_date makes the trip twice:
 *
 *   repurchasetab.transdate  2026-08-27 10:38:16   (MySQL NOW(), Manila)
 *   -> rank_achievementstab.achieved_at  2026-08-27 02:38:16   (-8h)
 *   -> rankingstab.rank_date             2026-08-26 18:38:16   (-16h)
 *
 * i.e. the rank was stamped the DAY BEFORE the repurchase that earned it.
 */
process.env.TZ = 'Asia/Manila';

const test = require('node:test');
const assert = require('node:assert');

const { toMysqlDateTime } = require('../../services/ranking');

// mysql2 with the default timezone:'local' turns a DATETIME string into a JS Date built
// from LOCAL components. Reproduce that exactly so the round-trip under test is the real one.
function readFromDb(datetimeString) {
  const [datePart, timePart] = datetimeString.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, ss);
}

test('test harness really is running in Manila (+8), else these assertions cannot discriminate', () => {
  assert.equal(new Date(2026, 7, 27).getTimezoneOffset(), -480,
    'TZ=Asia/Manila did not take effect; a UTC host would let the old toISOString() bug pass');
});

test('single round-trip preserves the wall-clock (was -8h)', () => {
  const stored = '2026-08-27 10:38:16';
  assert.equal(toMysqlDateTime(readFromDb(stored)), stored);
});

test('DOUBLE round-trip preserves the wall-clock — the actual rank_date path (was -16h)', () => {
  const transdate = '2026-08-27 10:38:16';        // repurchasetab.transdate, event id 4033
  const achievedAt = toMysqlDateTime(readFromDb(transdate));      // -> rank_achievementstab
  const rankDate   = toMysqlDateTime(readFromDb(achievedAt));     // -> rankingstab.rank_date

  assert.equal(achievedAt, transdate);
  assert.equal(rankDate, transdate);
  assert.notEqual(rankDate, '2026-08-26 18:38:16', 'regression: the original -16h shift is back');
});

test('a rank can never be stamped before the event that earned it', () => {
  const transdate = '2026-08-27 10:38:16';
  const rankDate = toMysqlDateTime(readFromDb(toMysqlDateTime(readFromDb(transdate))));
  assert.ok(readFromDb(rankDate).getTime() >= readFromDb(transdate).getTime(),
    `rank_date ${rankDate} precedes the qualifying event ${transdate}`);
});

test('month boundary: a rank earned just after midnight stays in the SAME month', () => {
  // The real risk of the -16h shift: anything earned in the first 16h of a month was
  // stamped to the PREVIOUS month, so month-scoped rank reports read the wrong period.
  const transdate = '2026-09-01 00:30:00';
  const rankDate = toMysqlDateTime(readFromDb(toMysqlDateTime(readFromDb(transdate))));
  assert.equal(rankDate.slice(0, 7), '2026-09');
  assert.notEqual(rankDate.slice(0, 7), '2026-08');
});

test('zero-padding is correct for single-digit month/day/time parts', () => {
  assert.equal(toMysqlDateTime(new Date(2026, 0, 5, 4, 7, 9)), '2026-01-05 04:07:09');
});

test('non-Date inputs behave as before', () => {
  assert.equal(toMysqlDateTime(null), null);
  assert.equal(toMysqlDateTime(undefined), null);
  assert.equal(toMysqlDateTime(''), null);
  assert.equal(toMysqlDateTime('2026-08-27T10:38:16Z'), '2026-08-27 10:38:16'); // string passthrough
  assert.equal(toMysqlDateTime(new Date('nonsense')), null);
});
