const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPairingLedgerEntries,
  summarizePairingTrace,
  summarizePairingBalances,
} = require('../../services/income/pairingTracker');

test('buildPairingLedgerEntries carries remaining points across multiple opposite-leg events', () => {
  const leftEvents = [
    {
      event_uid: 'left-a',
      source_member_uid: 101,
      owner_leg: 'left',
      point_value: 2500,
      event_ts: '2026-05-12T08:00:00.000Z',
      username: 'lefta',
      full_name: 'Left A',
    },
  ];

  const rightEvents = [
    {
      event_uid: 'right-a',
      source_member_uid: 202,
      owner_leg: 'right',
      point_value: 1000,
      event_ts: '2026-05-12T09:00:00.000Z',
      username: 'righta',
      full_name: 'Right A',
    },
    {
      event_uid: 'right-b',
      source_member_uid: 203,
      owner_leg: 'right',
      point_value: 750,
      event_ts: '2026-05-12T10:00:00.000Z',
      username: 'rightb',
      full_name: 'Right B',
    },
  ];

  const rows = buildPairingLedgerEntries({
    ownerUid: 999,
    accttype: 40,
    leftEvents,
    rightEvents,
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => ({
    left: row.leftEventUid,
    right: row.rightEventUid,
    pairPoints: row.pairPoints,
    payout: row.creditedIncome,
  })), [
    { left: 'left-a', right: 'right-a', pairPoints: 1000, payout: 1000 },
    { left: 'left-a', right: 'right-b', pairPoints: 750, payout: 750 },
  ]);
});

test('buildPairingLedgerEntries consumes matched points even after weekly cap is exhausted', () => {
  const leftEvents = [
    {
      event_uid: 'left-a',
      source_member_uid: 101,
      owner_leg: 'left',
      point_value: 12500,
      event_ts: '2026-05-12T08:00:00.000Z',
      username: 'lefta',
      full_name: 'Left A',
    },
  ];

  const rightEvents = [
    {
      event_uid: 'right-a',
      source_member_uid: 202,
      owner_leg: 'right',
      point_value: 10000,
      event_ts: '2026-05-12T09:00:00.000Z',
      username: 'righta',
      full_name: 'Right A',
    },
    {
      event_uid: 'right-b',
      source_member_uid: 203,
      owner_leg: 'right',
      point_value: 2500,
      event_ts: '2026-05-13T09:00:00.000Z',
      username: 'rightb',
      full_name: 'Right B',
    },
  ];

  const rows = buildPairingLedgerEntries({
    ownerUid: 999,
    accttype: 10,
    leftEvents,
    rightEvents,
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => ({
    pairPoints: row.pairPoints,
    grossIncome: row.grossIncome,
    creditedIncome: row.creditedIncome,
    capped: row.capApplied,
  })), [
    { pairPoints: 10000, grossIncome: 10000, creditedIncome: 10000, capped: false },
    { pairPoints: 2500, grossIncome: 2500, creditedIncome: 0, capped: true },
  ]);
});

test('buildPairingLedgerEntries stops new gold pairing credits after the monthly cap is reached', () => {
  const leftEvents = [
    {
      event_uid: 'left-a',
      source_member_uid: 101,
      owner_leg: 'left',
      point_value: 240000,
      event_ts: '2026-04-30T08:00:00.000Z',
      username: 'lefta',
      full_name: 'Left A',
    },
  ];

  const rightEvents = [
    {
      event_uid: 'right-a',
      source_member_uid: 202,
      owner_leg: 'right',
      point_value: 40000,
      event_ts: '2026-05-01T09:00:00.000Z',
      username: 'righta',
      full_name: 'Right A',
    },
    {
      event_uid: 'right-b',
      source_member_uid: 203,
      owner_leg: 'right',
      point_value: 40000,
      event_ts: '2026-05-08T09:00:00.000Z',
      username: 'rightb',
      full_name: 'Right B',
    },
    {
      event_uid: 'right-c',
      source_member_uid: 204,
      owner_leg: 'right',
      point_value: 40000,
      event_ts: '2026-05-15T09:00:00.000Z',
      username: 'rightc',
      full_name: 'Right C',
    },
    {
      event_uid: 'right-d',
      source_member_uid: 205,
      owner_leg: 'right',
      point_value: 40000,
      event_ts: '2026-05-22T09:00:00.000Z',
      username: 'rightd',
      full_name: 'Right D',
    },
    {
      event_uid: 'right-e',
      source_member_uid: 206,
      owner_leg: 'right',
      point_value: 40000,
      event_ts: '2026-05-29T09:00:00.000Z',
      username: 'righte',
      full_name: 'Right E',
    },
    {
      event_uid: 'right-f',
      source_member_uid: 207,
      owner_leg: 'right',
      point_value: 40000,
      event_ts: '2026-06-05T09:00:00.000Z',
      username: 'rightf',
      full_name: 'Right F',
    },
  ];

  const rows = buildPairingLedgerEntries({
    ownerUid: 999,
    accttype: 30,
    leftEvents,
    rightEvents,
  });

  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.creditedIncome), [40000, 40000, 40000, 40000, 0, 40000]);
  assert.equal(rows[4].grossIncome, 40000);
  assert.equal(rows[4].pairMonthCap, 160000);
  assert.equal(rows[5].creditedIncome, 40000);
});

test('summarizePairingTrace separates credited and cap-blocked matches for UI audit surfaces', () => {
  const summary = summarizePairingTrace([
    {
      pairPoints: 1000,
      grossIncome: 1000,
      creditedIncome: 1000,
      capApplied: false,
    },
    {
      pairPoints: 2500,
      grossIncome: 2500,
      creditedIncome: 0,
      capApplied: true,
    },
  ]);

  assert.deepEqual(summary, {
    totalEvents: 2,
    totalPairPoints: 3500,
    totalGrossIncome: 3500,
    totalCreditedIncome: 1000,
    totalBlockedIncome: 2500,
    totalFlushoutIncome: 2500,
    companyRetainedIncome: 2500,
    lockedEvents: 0,
    cappedEvents: 1,
    uncappedEvents: 1,
  });
});

test('buildPairingLedgerEntries preserves flushout totals when credits are eligibility-locked', () => {
  const rows = buildPairingLedgerEntries({
    ownerUid: 999,
    accttype: 10,
    leftEvents: [{
      event_uid: 'left-a',
      source_member_uid: 101,
      owner_leg: 'left',
      point_value: 500,
      event_ts: '2026-05-12T08:00:00.000Z',
      username: 'lefta',
      full_name: 'Left A',
    }],
    rightEvents: [{
      event_uid: 'right-a',
      source_member_uid: 202,
      owner_leg: 'right',
      point_value: 500,
      event_ts: '2026-05-12T09:00:00.000Z',
      username: 'righta',
      full_name: 'Right A',
    }],
    creditsLocked: true,
    creditsLockedReason: 'owner-frozen',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].pairPoints, 500);
  assert.equal(rows[0].grossIncome, 500);
  assert.equal(rows[0].creditedIncome, 0);
  assert.equal(rows[0].capApplied, false);
  assert.equal(rows[0].eligibilityLocked, true);
  assert.equal(rows[0].eligibilityLockedReason, 'owner-frozen');

  assert.deepEqual(summarizePairingTrace(rows), {
    totalEvents: 1,
    totalPairPoints: 500,
    totalGrossIncome: 500,
    totalCreditedIncome: 0,
    totalBlockedIncome: 500,
    totalFlushoutIncome: 500,
    companyRetainedIncome: 500,
    lockedEvents: 1,
    cappedEvents: 0,
    uncappedEvents: 0,
  });
});

test('buildPairingLedgerEntries treats persisted binary values as the payout-equivalent amount', () => {
  const rows = buildPairingLedgerEntries({
    ownerUid: 999,
    accttype: 40,
    leftEvents: [{
      event_uid: 'left-db',
      source_member_uid: 101,
      owner_leg: 'left',
      package_type: '40',
      point_value: 2500,
      event_ts: '2026-05-22T01:41:38.000Z',
      username: 'spillover',
      full_name: 'Spillover Left',
    }],
    rightEvents: [{
      event_uid: 'right-db',
      source_member_uid: 202,
      owner_leg: 'right',
      package_type: '10',
      point_value: 250,
      event_ts: '2026-05-22T01:39:03.000Z',
      username: 'testcarl',
      full_name: 'TestCarl',
    }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].pairPoints, 250);
  assert.equal(rows[0].grossIncome, 250);
  assert.equal(rows[0].creditedIncome, 250);
});

test('summarizePairingBalances exposes raw subtree totals and unpaired carry separately', () => {
  const balances = summarizePairingBalances({
    leftEvents: [
      { point_value: 2500, package_type: '40' },
      { point_value: 500, package_type: '20' },
    ],
    rightEvents: [
      { point_value: 250, package_type: '10' },
    ],
    ledgerRows: [
      { pairPoints: 250, grossIncome: 250 },
    ],
  });

  assert.deepEqual(balances, {
    totalLeftPoints: 3000,
    totalRightPoints: 250,
    pairedPoints: 250,
    availableLeftPoints: 2750,
    availableRightPoints: 0,
    weakLegPoints: 0,
    strongLegPoints: 2750,
  });
});
