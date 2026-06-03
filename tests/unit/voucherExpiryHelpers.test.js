const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UNUSED_VOUCHER_EXPIRY_MONTHS,
  USED_VOUCHER_EXPIRY_DAYS,
  buildVoucherExpiryLabel,
  getVoucherExpiryMode,
} = require('../../services/voucher');

test('voucher expiry ladders split unused month windows from used day windows', () => {
  assert.deepEqual(
    UNUSED_VOUCHER_EXPIRY_MONTHS,
    { 10: 2, 20: 2, 30: 4, 40: 4, 50: 6, 60: 6 }
  );
  assert.deepEqual(
    USED_VOUCHER_EXPIRY_DAYS,
    { 10: 30, 20: 40, 30: 45, 40: 50, 50: 55, 60: 60 }
  );
});

test('voucher expiry helpers switch from unused to used mode after first use', () => {
  const realNow = Date.now;
  const fixedNow = Date.parse('2026-05-22T00:00:00.000Z');
  Date.now = () => fixedNow;

  try {
    assert.equal(getVoucherExpiryMode({ first_used_at: null }), 'unused');
    assert.equal(getVoucherExpiryMode({ first_used_at: '2026-05-21' }), 'used');

    assert.equal(
      buildVoucherExpiryLabel({
        unusedExpiryDate: '2026-05-24T00:00:00.000Z',
        usedExpiryDate: null,
        firstUsedAt: null,
        status: 1,
      }),
      '2 days left'
    );

    assert.equal(
      buildVoucherExpiryLabel({
        unusedExpiryDate: '2026-06-22T00:00:00.000Z',
        usedExpiryDate: '2026-05-23T00:00:00.000Z',
        firstUsedAt: '2026-05-22T00:00:00.000Z',
        status: 1,
      }),
      '1 day left'
    );
  } finally {
    Date.now = realNow;
  }
});

test('voucher expiry labels keep status precedence over countdown text', () => {
  assert.equal(
    buildVoucherExpiryLabel({
      unusedExpiryDate: '2026-05-24T00:00:00.000Z',
      usedExpiryDate: null,
      firstUsedAt: null,
      status: 2,
    }),
    'Expired'
  );
  assert.equal(
    buildVoucherExpiryLabel({
      unusedExpiryDate: '2026-05-24T00:00:00.000Z',
      usedExpiryDate: null,
      firstUsedAt: null,
      status: 4,
    }),
    'Suspended'
  );
});
