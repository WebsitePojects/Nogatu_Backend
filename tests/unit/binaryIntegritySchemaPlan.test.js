const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('phase1 migration creates placement audit and activation code usage tables', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../../migrations/V010__binary_integrity_phase1.sql'),
    'utf8'
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS binary_placement_audittab/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS activation_code_usagetab/i);
  assert.match(sql, /ALTER TABLE public_registration_audittab/i);
  assert.match(sql, /memberstab/i);
});
