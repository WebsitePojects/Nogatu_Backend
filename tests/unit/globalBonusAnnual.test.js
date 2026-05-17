const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAnnualYear,
  assertClosedDistributionYear,
  getLastClosedYear,
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
