// Sir Dino 2026-11-23: the four "paid-recorded CD" accounts become unpaid CD (their own encashments
// are deducted) while their uplines keep earning as if nothing changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dbPath = path.resolve(__dirname, '..', '..', 'config', 'database.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: { query: async () => { throw new Error('no db in this test'); } } } };

const {
  countsForPairingSource,
  countsForDirectReferralSource,
  getAccountEntryAuditInfo,
  isUplineNeutralCd,
  UPLINE_NEUTRAL_CD_UIDS,
} = require('../../services/accountState');

const FOUR = [6581504, 4584545, 5658589, 3933627];
const unpaidCd = (uid) => ({ uid, codeid: 3, cdstatus: 1, cdamount: 5000, cdtotal: 0 });

test('the exception list is exactly the four accounts Sir Dino named', () => {
  assert.deepEqual([...UPLINE_NEUTRAL_CD_UIDS].sort(), [...FOUR].sort());
  assert.ok(Object.isFrozen(UPLINE_NEUTRAL_CD_UIDS));
});

test('the four still count as pairing and direct-referral sources while unpaid CD', () => {
  for (const uid of FOUR) {
    assert.equal(countsForPairingSource(unpaidCd(uid)), true, `pairing ${uid}`);
    assert.equal(countsForDirectReferralSource(unpaidCd(uid)), true, `DR ${uid}`);
    assert.equal(countsForPairingSource(unpaidCd(String(uid))), true, 'uid as string from a query');
    const audit = getAccountEntryAuditInfo(unpaidCd(uid));
    assert.equal(audit.entryCode, 'CD');
    assert.equal(audit.sponsorCreditEligible, true);
    assert.equal(audit.sourceBinaryEligible, true);
  }
});

test('every other unpaid CD account is unchanged: not a source', () => {
  for (const uid of [1, 155253, 1961878, 6581505, 0]) {
    assert.equal(countsForPairingSource(unpaidCd(uid)), false, `pairing ${uid}`);
    assert.equal(countsForDirectReferralSource(unpaidCd(uid)), false, `DR ${uid}`);
    assert.equal(getAccountEntryAuditInfo(unpaidCd(uid)).sourceBinaryEligible, false);
  }
  // A row without uid can never match the exception.
  assert.equal(countsForPairingSource({ codeid: 3, cdstatus: 1, cdamount: 5000, cdtotal: 0 }), false);
});

test('the exception only applies while they are CD: FS rules stay FS', () => {
  for (const uid of FOUR) {
    assert.equal(isUplineNeutralCd({ uid, codeid: 2 }), false);
    assert.equal(countsForPairingSource({ uid, codeid: 2, cdstatus: 0 }), false);
    assert.equal(countsForPairingSource({ uid, codeid: 1, cdstatus: 0 }), true);
    assert.equal(countsForPairingSource({ uid, codeid: 3, cdstatus: 2, cdamount: 5000, cdtotal: 5000 }), true);
  }
});

test('the CD deduction rule for the four themselves is not touched by the exception', () => {
  const insertIncome = require('fs').readFileSync(path.resolve(__dirname, '..', '..', 'services', 'income', 'insertIncome.js'), 'utf8');
  assert.doesNotMatch(insertIncome, /isUplineNeutralCd|UPLINE_NEUTRAL_CD/);
});
