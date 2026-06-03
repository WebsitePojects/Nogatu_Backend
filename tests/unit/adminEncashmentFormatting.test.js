const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __private: {
    normalizePayoutOption,
    buildPayoutDisplay,
    mapEncashmentRow,
  },
} = require('../../routes/admin/encashment');

test('normalizePayoutOption accepts both numeric ids and legacy string labels', () => {
  assert.deepEqual(normalizePayoutOption(2), {
    id: 2,
    label: 'GCash',
    raw: '2',
  });

  assert.deepEqual(normalizePayoutOption('Gcash'), {
    id: 2,
    label: 'GCash',
    raw: 'Gcash',
  });

  assert.deepEqual(normalizePayoutOption('Remittance Centers'), {
    id: 3,
    label: 'Remittance Center',
    raw: 'Remittance Centers',
  });
});

test('buildPayoutDisplay avoids poisoning payout details with N/A prefixes', () => {
  assert.equal(buildPayoutDisplay('', '09171234567'), '09171234567');
  assert.equal(buildPayoutDisplay('GCash', '09171234567'), 'GCash / 09171234567');
  assert.equal(buildPayoutDisplay('GCash', 'GCash / 09171234567'), 'GCash / 09171234567');
});

test('mapEncashmentRow falls back to profile payout values when history option is missing', () => {
  const row = mapEncashmentRow({
    pid: 1,
    uid: 2,
    firstname: 'Rowell',
    lastname: 'Mahinay',
    paymentoptions: null,
    paymentdetails: null,
    payoutid: 'Gcash',
    payoutdetails: '09455777344',
    encashment1: 1000,
    tax_1: 100,
    encashmentfee: 50,
    cddeduction: 0,
    cashstatus: 0,
  });

  assert.equal(row.payoutOption, 'GCash');
  assert.equal(row.payoutDetails, 'GCash / 09455777344');
  assert.equal(row.payoutId, 2);
});
