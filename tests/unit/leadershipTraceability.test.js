const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rateForLeadershipLevel,
  summarizeLeadershipTraceability,
} = require('../../services/income/leadership');

test('leadership rates follow the approved 5-2-1 ladder', () => {
  assert.equal(rateForLeadershipLevel(1), 0.05);
  assert.equal(rateForLeadershipLevel(2), 0.02);
  assert.equal(rateForLeadershipLevel(3), 0.01);
  assert.equal(rateForLeadershipLevel(5), 0.01);
  assert.equal(rateForLeadershipLevel(6), 0);
});

test('leadership traceability summarizes source pairing income into auditable bonus rows', () => {
  const trace = summarizeLeadershipTraceability([
    { uid: 101, username: 'alice', fullName: 'Alice Reyes', level: 1, pairingIncome: 10000, directReferralCount: 3 },
    { uid: 202, username: 'bob', fullName: 'Bob Cruz', level: 2, pairingIncome: 5000, directReferralCount: 1 },
    { uid: 303, username: 'cara', fullName: 'Cara Lim', level: 4, pairingIncome: 2000, directReferralCount: 0 },
  ]);

  assert.equal(trace.totalBonus, 620);
  assert.equal(trace.totalSources, 3);
  assert.deepEqual(trace.rows.map((row) => ({
    username: row.username,
    level: row.level,
    ratePercent: row.ratePercent,
    pairingIncome: row.pairingIncome,
    leadershipBonus: row.leadershipBonus,
    directReferralCount: row.directReferralCount,
  })), [
    { username: 'alice', level: 1, ratePercent: 5, pairingIncome: 10000, leadershipBonus: 500, directReferralCount: 3 },
    { username: 'bob', level: 2, ratePercent: 2, pairingIncome: 5000, leadershipBonus: 100, directReferralCount: 1 },
    { username: 'cara', level: 4, ratePercent: 1, pairingIncome: 2000, leadershipBonus: 20, directReferralCount: 0 },
  ]);
});
