const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countsForDirectReferralSource,
} = require('../../services/income/directReferral');

test('direct referral eligibility mirrors live PHP direct referral source rules', () => {
  assert.equal(countsForDirectReferralSource({ codeid: 1 }), true);
  assert.equal(countsForDirectReferralSource({ codeid: 3, cdstatus: 2, cdamount: 2500, cdtotal: 2500 }), true);
  assert.equal(countsForDirectReferralSource({ codeid: 3, cdstatus: 2, cdamount: 0, cdtotal: 0 }), true);
  assert.equal(countsForDirectReferralSource({ codeid: 2 }), false);
  assert.equal(countsForDirectReferralSource({ codeid: 3, cdstatus: 1, cdamount: 2500, cdtotal: 1000 }), false);
  assert.equal(countsForDirectReferralSource({ codeid: 3, cdstatus: 1, cdamount: 2500, cdtotal: 2500 }), false);
  assert.equal(countsForDirectReferralSource({ codeid: 3, cdstatus: 0, cdamount: 0, cdtotal: 0 }), false);
});

test('direct referral eligibility still excludes non-entry rows', () => {
  assert.equal(countsForDirectReferralSource({ codeid: 0 }), false);
});
