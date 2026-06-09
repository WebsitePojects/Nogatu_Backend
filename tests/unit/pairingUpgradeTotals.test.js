const test = require('node:test');
const assert = require('node:assert/strict');

function loadPairingServiceWithMocks(options) {
  const pairingPath = require.resolve('../../services/income/pairing');
  const databasePath = require.resolve('../../config/database');
  const accountStatePath = require.resolve('../../services/accountState');
  const binaryEligibilityPath = require.resolve('../../services/binaryEligibility');
  const packagePolicyPath = require.resolve('../../services/packagePolicy');

  delete require.cache[pairingPath];
  delete require.cache[databasePath];
  delete require.cache[accountStatePath];
  delete require.cache[binaryEligibilityPath];
  delete require.cache[packagePolicyPath];

  require.cache[databasePath] = {
    exports: {
      pool: {
        query: async (sql, params) => options.query(sql, params),
      },
    },
  };

  require.cache[accountStatePath] = {
    exports: {
      getEffectiveAccountState: async (uid, row) => options.getEffectiveAccountState(uid, row),
      countsForPairingSource: (row) => options.countsForPairingSource(row),
    },
  };

  require.cache[binaryEligibilityPath] = {
    exports: {
      getBinaryPairingEligibility: async () => ({ canEarnPairing: true }),
    },
  };

  require.cache[packagePolicyPath] = {
    exports: {
      getPackagePairingDepthLimit: () => null,
      getPackagePairingWeeklyCap: () => 1000000,
      getPackagePairingMonthlyCap: () => 0,
      getPackageSealingPoint: () => 0,
      listPackagePolicies: () => [],
    },
  };

  return require(pairingPath);
}

test('upgrade-driven pairing totals include appended upgrade points in daily report totals', async () => {
  const pairing = loadPairingServiceWithMocks({
    query: async (sql, params) => {
      if (sql.indexOf('FROM usertab') >= 0) {
        if (Number(params[0]) === 100) {
          return [[{
            uid: 200,
            refid: 100,
            drefid: 100,
            position: 2,
            codeid: 1,
            accttype: 20,
            currentaccttype: 60,
            cdamount: 0,
            cdtotal: 0,
            cdstatus: 0,
            binarypoints: 500,
            datereg: '2026-04-20 08:00:00',
          }]];
        }

        return [[]];
      }

      if (sql.indexOf('FROM upgradetab') >= 0) {
        return [[{
          uid: 200,
          transdate: '2026-04-21',
          binarypoints: 15000,
          transtype: 1,
        }]];
      }

      throw new Error('Unexpected SQL: ' + sql);
    },
    getEffectiveAccountState: async (uid, row) => {
      if (!row && Number(uid) === 100) {
        return {
          uid: 100,
          accttype: 20,
          currentaccttype: 20,
          codeid: 1,
          cdamount: 0,
          cdtotal: 0,
          cdstatus: 0,
        };
      }

      return row;
    },
    countsForPairingSource: () => true,
  });

  const result = await pairing.getPairing(100, 20);
  const upgradeDayReport = result.dailyReports.find((row) => row.transdate === '2026-04-21');

  assert.equal(result.rightPts, 15500);
  assert.ok(upgradeDayReport);
  assert.equal(upgradeDayReport.totalpointsright, 15500);
});
