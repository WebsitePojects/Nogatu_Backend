const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getAccountStateLabel,
  getAccountEntryAuditInfo,
} = require('../../services/accountState');

test('account state labels distinguish PD, FS, CD, and CD paid states', () => {
  assert.equal(getAccountStateLabel({ codeid: 1, cdstatus: 0 }), 'PD');
  assert.equal(getAccountStateLabel({ codeid: 2, cdstatus: 0 }), 'FS');
  assert.equal(getAccountStateLabel({ codeid: 3, cdstatus: 1 }), 'CD');
  assert.equal(getAccountStateLabel({ codeid: 3, cdstatus: 2 }), 'CD - Paid');
});

test('account entry audit flags match live direct-referral and pairing eligibility', () => {
  assert.equal(getAccountEntryAuditInfo({ codeid: 1 }).sponsorCreditEligible, true);
  assert.equal(getAccountEntryAuditInfo({ codeid: 1 }).sourceBinaryEligible, true);

  assert.equal(getAccountEntryAuditInfo({ codeid: 2 }).sponsorCreditEligible, false);
  assert.equal(getAccountEntryAuditInfo({ codeid: 2 }).sourceBinaryEligible, false);

  assert.equal(
    getAccountEntryAuditInfo({ codeid: 3, cdstatus: 1, cdamount: 5000, cdtotal: 2500 }).sponsorCreditEligible,
    false
  );
  assert.equal(
    getAccountEntryAuditInfo({ codeid: 3, cdstatus: 2, cdamount: 5000, cdtotal: 5000 }).sponsorCreditEligible,
    true
  );
});
