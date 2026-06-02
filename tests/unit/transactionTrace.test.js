const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickRowsByExactAmount,
} = require('../../services/transactionTrace');

test('transaction trace matching finds an exact recent subset for contributor rows', () => {
  const rows = pickRowsByExactAmount([
    { amount: 2500, transdate: '2026-05-22 01:41:38', username: 'TestMarkBy00001' },
    { amount: 500, transdate: '2026-05-22 01:30:52', username: 'TestJohn' },
    { amount: 250, transdate: '2026-05-22 01:39:03', username: 'TestCarl' },
  ], 3000, '2026-05-22 01:41:43');

  assert.deepEqual(rows.map((row) => row.username), ['TestMarkBy00001', 'TestJohn']);
});
