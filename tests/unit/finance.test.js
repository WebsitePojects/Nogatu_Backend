const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateEncashmentBreakdown,
  validatePayoutDetails,
} = require('../../utils/finance');
const {
  createProcessKey,
  maskSensitiveValue,
  normalizeReferralSlug,
} = require('../../utils/security');

test('encashment breakdown includes tax, processing fee, maintenance fee, and CD deduction', () => {
  const result = calculateEncashmentBreakdown({
    amount: 1000,
    cdRemaining: 500,
    isCdDeductionActive: true,
  });

  assert.equal(result.gross, 1000);
  assert.equal(result.tax, 100);
  assert.equal(result.processingFee, 50);
  assert.equal(result.maintenanceFee, 20);
  assert.equal(result.cdDeduction, 250);
  assert.equal(result.totalDeductions, 420);
  assert.equal(result.net, 580);
});

test('encashment CD deduction is capped by remaining CD obligation', () => {
  const result = calculateEncashmentBreakdown({
    amount: 1000,
    cdRemaining: 100,
    isCdDeductionActive: true,
  });

  assert.equal(result.cdDeduction, 100);
  assert.equal(result.net, 730);
});

test('payout validation requires both option and details', () => {
  assert.equal(validatePayoutDetails({ payoutId: 2, payoutDetails: '09123456789' }).ok, true);
  assert.equal(validatePayoutDetails({ payoutId: 0, payoutDetails: '09123456789' }).ok, false);
  assert.equal(validatePayoutDetails({ payoutId: 2, payoutDetails: '' }).ok, false);
});

test('process keys are deterministic and input-sensitive', () => {
  const keyA = createProcessKey(['encashment', 10, 'pid', 123]);
  const keyB = createProcessKey(['encashment', 10, 'pid', 123]);
  const keyC = createProcessKey(['encashment', 11, 'pid', 123]);

  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.match(keyA, /^[a-f0-9]{64}$/);
});

test('maskSensitiveValue hides the middle of member payout/account data', () => {
  assert.equal(maskSensitiveValue('09123456789'), '*******6789');
  assert.equal(maskSensitiveValue('abc'), '***');
});

test('normalizeReferralSlug keeps public URLs non-enumerable and clean', () => {
  assert.equal(normalizeReferralSlug(' AB-cd_12!! '), 'abcd12');
});
