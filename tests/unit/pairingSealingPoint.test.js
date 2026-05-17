const test = require('node:test');
const assert = require('node:assert/strict');

const { totalPairingAmount } = require('../../services/income/pairing');

test('totalPairingAmount enforces the monthly gold pairing cap while preserving daily history', () => {
  const leftPoints = [
    { points: 40000, date: '2026-05-01 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-08 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-15 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-22 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-29 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-06-05 00:00:00', codeid: 1 },
  ];
  const rightPoints = [
    { points: 40000, date: '2026-05-01 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-08 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-15 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-22 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-05-29 00:00:00', codeid: 1 },
    { points: 40000, date: '2026-06-05 00:00:00', codeid: 1 },
  ];
  const allDates = new Set(leftPoints.map((row) => row.date));

  const result = totalPairingAmount(leftPoints, rightPoints, allDates, 30, {
    totalleft: 6,
    totalpointsleft: 240000,
    totalright: 6,
    totalpointsright: 240000,
  });

  assert.equal(result.totalPay, 200000);
  assert.equal(result.dailyReports.length, 6);
  assert.equal(result.dailyReports[3].totalbpay, 160000);
  assert.equal(result.dailyReports[4].totalbpay, 160000);
  assert.equal(result.dailyReports[4].totalpoints, 0);
  assert.equal(result.dailyReports[5].totalbpay, 200000);
  assert.equal(result.dailyReports[5].totalpoints, 40000);
});
