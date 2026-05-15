const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateLetterOfIntentFile,
  normalizeApplicationFields,
} = require('../../routes/applications');

test('letter of intent upload accepts pdf files', () => {
  const outcome = validateLetterOfIntentFile({
    originalname: 'letter-of-intent.pdf',
    mimetype: 'application/pdf',
    size: 1024,
  });

  assert.equal(outcome.ok, true);
});

test('letter of intent upload rejects unsupported file types', () => {
  const outcome = validateLetterOfIntentFile({
    originalname: 'script.exe',
    mimetype: 'application/octet-stream',
    size: 1024,
  });

  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /PDF|DOC|DOCX|image/i);
});

test('application normalization trims name, phone, and email', () => {
  const fields = normalizeApplicationFields({
    name: '  Vergel Bautista  ',
    phone: ' 09123456789 ',
    email: ' VERGEL@EXAMPLE.COM ',
  });

  assert.deepEqual(fields, {
    name: 'Vergel Bautista',
    phone: '09123456789',
    email: 'vergel@example.com',
  });
});
