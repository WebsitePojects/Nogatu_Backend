const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeApplicationFields } = require('../../routes/applications');

test('application normalization trims name, sponsor name, phone, and email', () => {
  const fields = normalizeApplicationFields({
    name: '  Vergel Bautista  ',
    sponsorName: '  Juan Dela Cruz  ',
    phone: ' 09123456789 ',
    email: ' VERGEL@EXAMPLE.COM ',
  });

  assert.deepEqual(fields, {
    name: 'Vergel Bautista',
    sponsorName: 'Juan Dela Cruz',
    phone: '09123456789',
    email: 'vergel@example.com',
  });
});
