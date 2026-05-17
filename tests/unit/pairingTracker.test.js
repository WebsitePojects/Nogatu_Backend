const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPairingLedgerEntries,
  summarizePairingTrace,
} = require('../../services/income/pairingTracker');

test('buildPairingLedgerEntries carries remaining points across multiple opposite-leg events', () => {
  const leftEvents = [
    {
      event_uid: 'left-a',
      source_member_uid: 101,
      owner_leg: 'left',
      point_value: 10,
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
      point_value: 4,
      event_ts: '2026-05-12T09:00:00.000Z',
      username: 'righta',
      full_name: 'Right A',
    },
    {
      event_uid: 'right-b',
      source_member_uid: 203,
      owner_leg: 'right',
      point_value: 3,
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
    { left: 'left-a', right: 'right-a', pairPoints: 4, payout: 1000 },
    { left: 'left-a', right: 'right-b', pairPoints: 3, payout: 750 },
  ]);
});

test('buildPairingLedgerEntries consumes matched points even after weekly cap is exhausted', () => {
  const leftEvents = [
    {
      event_uid: 'left-a',
      source_member_uid: 101,
      owner_leg: 'left',
      point_value: 50,
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
      point_value: 40,
      event_ts: '2026-05-12T09:00:00.000Z',
      username: 'righta',
      full_name: 'Right A',
    },
    {
      event_uid: 'right-b',
      source_member_uid: 203,
      owner_leg: 'right',
      point_value: 10,
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
    { pairPoints: 40, grossIncome: 10000, creditedIncome: 10000, capped: false },
    { pairPoints: 10, grossIncome: 2500, creditedIncome: 0, capped: true },
  ]);
});

test('buildPairingLedgerEntries stops new gold pairing credits after the monthly cap is reached', () => {
  const leftEvents = [
    {
      event_uid: 'left-a',
      source_member_uid: 101,
      owner_leg: 'left',
      point_value: 960,
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
      point_value: 160,
      event_ts: '2026-05-01T09:00:00.000Z',
      username: 'righta',
      full_name: 'Right A',
    },
    {
      event_uid: 'right-b',
      source_member_uid: 203,
      owner_leg: 'right',
      point_value: 160,
      event_ts: '2026-05-08T09:00:00.000Z',
      username: 'rightb',
      full_name: 'Right B',
    },
    {
      event_uid: 'right-c',
      source_member_uid: 204,
      owner_leg: 'right',
      point_value: 160,
      event_ts: '2026-05-15T09:00:00.000Z',
      username: 'rightc',
      full_name: 'Right C',
    },
    {
      event_uid: 'right-d',
      source_member_uid: 205,
      owner_leg: 'right',
      point_value: 160,
      event_ts: '2026-05-22T09:00:00.000Z',
      username: 'rightd',
      full_name: 'Right D',
    },
    {
      event_uid: 'right-e',
      source_member_uid: 206,
      owner_leg: 'right',
      point_value: 160,
      event_ts: '2026-05-29T09:00:00.000Z',
      username: 'righte',
      full_name: 'Right E',
    },
    {
      event_uid: 'right-f',
      source_member_uid: 207,
      owner_leg: 'right',
      point_value: 160,
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
      pairPoints: 4,
      grossIncome: 1000,
      creditedIncome: 1000,
      capApplied: false,
    },
    {
      pairPoints: 10,
      grossIncome: 2500,
      creditedIncome: 0,
      capApplied: true,
    },
  ]);

  assert.deepEqual(summary, {
    totalEvents: 2,
    totalPairPoints: 14,
    totalGrossIncome: 3500,
    totalCreditedIncome: 1000,
    cappedEvents: 1,
    uncappedEvents: 1,
  });
});
