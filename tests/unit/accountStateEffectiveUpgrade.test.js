const test = require('node:test');
const assert = require('node:assert/strict');

const { getEffectiveAccountState } = require('../../services/accountState');

test('effective upgrade state preserves traversal fields while refreshing a paid upgrade', async () => {
  const runner = {
    query: async (sql) => {
      if (sql.includes('FROM usertab')) {
        return [[{
          uid: 55,
          accttype: 10,
          currentaccttype: 40,
          codeid: 3,
          cdamount: 25000,
          cdtotal: 5000,
          cdstatus: 1,
        }]];
      }

      if (sql.includes('FROM upgradetab')) {
        return [[{
          uid: 55,
          producttype: 40,
          upgradecodeid: 77,
          codetype: 1,
          productamount: 25000,
        }]];
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const result = await getEffectiveAccountState(55, {
    uid: 55,
    refid: 99,
    drefid: 88,
    position: 1,
    binarypoints: 10,
    activedate: '2026-05-22 00:00:00',
  }, runner);

  assert.equal(result.refid, 99);
  assert.equal(result.drefid, 88);
  assert.equal(result.position, 1);
  assert.equal(result.binarypoints, 10);
  assert.equal(result.codeid, 1);
  assert.equal(result.cdamount, 25000);
  assert.equal(result.cdtotal, 25000);
  assert.equal(result.cdstatus, 2);
  assert.equal(result.raw_codeid, 3);
  assert.equal(result.raw_cdamount, 25000);
  assert.equal(result.raw_cdtotal, 5000);
  assert.equal(result.raw_cdstatus, 1);
  assert.equal(result.upgrade_codetype, 1);
  assert.equal(result.upgrade_productamount, 25000);
});

test('effective upgrade state resets CD progress to the fresh upgrade obligation for CD upgrades', async () => {
  const runner = {
    query: async (sql) => {
      if (sql.includes('FROM upgradetab')) {
        return [[{
          uid: 81,
          producttype: 40,
          upgradecodeid: 91,
          codetype: 3,
          productamount: 25000,
        }]];
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const result = await getEffectiveAccountState(81, {
    uid: 81,
    accttype: 10,
    currentaccttype: 40,
    codeid: 3,
    cdamount: 5000,
    cdtotal: 5000,
    cdstatus: 2,
  }, runner);

  assert.equal(result.codeid, 3);
  assert.equal(result.cdamount, 25000);
  assert.equal(result.cdtotal, 0);
  assert.equal(result.cdstatus, 1);
  assert.equal(result.raw_cdamount, 5000);
  assert.equal(result.raw_cdtotal, 5000);
  assert.equal(result.raw_cdstatus, 2);
  assert.equal(result.upgrade_codetype, 3);
  assert.equal(result.upgrade_productamount, 25000);
});

test('fresh referral-link CD registrations stay unpaid when no upgrade row exists', async () => {
  const runner = {
    query: async (sql) => {
      if (sql.includes('FROM upgradetab')) {
        throw new Error(`Unexpected upgrade lookup for fresh registration: ${sql}`);
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const result = await getEffectiveAccountState(90210, {
    uid: 90210,
    accttype: 40,
    currentaccttype: 40,
    codeid: 3,
    cdamount: 25000,
    cdtotal: 0,
    cdstatus: 1,
    refid: 70001,
    drefid: 60001,
    position: 2,
  }, runner);

  assert.equal(result.codeid, 3);
  assert.equal(result.cdamount, 25000);
  assert.equal(result.cdtotal, 0);
  assert.equal(result.cdstatus, 1);
  assert.equal(result.refid, 70001);
  assert.equal(result.drefid, 60001);
  assert.equal(result.position, 2);
  assert.equal(result.upgrade_codetype, 0);
  assert.equal(result.upgrade_productamount, 0);
});
