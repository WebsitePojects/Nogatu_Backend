const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAnnualYear,
  assertClosedDistributionYear,
  getLastClosedYear,
  buildGlobalBonusVisibility,
} = require('../../services/globalBonus');
const { normalizeFinanceYear } = require('../../services/adminFinance');

test('global bonus defaults to the last closed year when no year is supplied', () => {
  const fakeNow = new Date('2026-05-15T08:00:00.000Z');
  assert.equal(getLastClosedYear(fakeNow), 2025);
  assert.equal(normalizeAnnualYear(undefined, fakeNow), 2025);
});

test('global bonus rejects distribution for the current year because the year is still open', () => {
  const fakeNow = new Date('2026-05-15T08:00:00.000Z');
  assert.throws(
    () => assertClosedDistributionYear(2026, fakeNow),
    /fully completed year/
  );
  assert.equal(assertClosedDistributionYear(2025, fakeNow), 2025);
});

test('finance year normalization falls back to the current year', () => {
  const fakeNow = new Date('2026-05-15T08:00:00.000Z');
  assert.equal(normalizeFinanceYear(undefined, fakeNow), 2026);
  assert.equal(normalizeFinanceYear(2024, fakeNow), 2024);
});

test('global bonus visibility metadata unlocks with the qualifying labels', () => {
  assert.deepEqual(
    buildGlobalBonusVisibility({ eligible: true, labels: ['Diamond', 'Ambassador'] }),
    {
      visibilityState: 'unlocked',
      interactive: true,
      fullVisibility: true,
      lockedReason: null,
      unlockedBy: ['Diamond', 'Ambassador'],
    }
  );
});

test('global bonus visibility metadata stays locked for non-qualifying accounts', () => {
  assert.deepEqual(
    buildGlobalBonusVisibility({ eligible: false, labels: ['Bronze'] }),
    {
      visibilityState: 'locked',
      interactive: false,
      fullVisibility: false,
      lockedReason: 'Global bonus unlocks for qualified Diamond, Ambassador, or eligible Stockist accounts.',
      unlockedBy: [],
    }
  );
});
