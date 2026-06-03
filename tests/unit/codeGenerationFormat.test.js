const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PACKAGE_ABBREVIATIONS,
  buildEntryCodePrefix,
  buildGeneratedCode,
} = require('../../services/codeGeneration');

test('entry package code prefixes include both the code type and package abbreviation', () => {
  assert.equal(PACKAGE_ABBREVIATIONS[10], 'BR');
  assert.equal(PACKAGE_ABBREVIATIONS[40], 'PL');
  assert.equal(buildEntryCodePrefix(10, 1), 'PDBR');
  assert.equal(buildEntryCodePrefix(40, 3), 'CDPL');
});

test('generated entry and maintenance codes keep their current prefix formats', () => {
  const entryCode = buildGeneratedCode(6100123, 40, 3);
  const maintenanceCode = buildGeneratedCode(710123, 100, 2);

  assert.match(entryCode, /^CDPL[A-Z0-9]{8}$/);
  assert.match(maintenanceCode, /^MC[A-Z0-9]{10}$/);
});
