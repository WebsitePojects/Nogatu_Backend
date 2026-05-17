const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatActivationHistoryEntry,
} = require('../../services/codeHistory');

test('activation history formatter exposes clear transfer and release labels', () => {
  const releaseRow = formatActivationHistoryEntry({
    code: 'ABC123',
    event_type: 'release',
    actor_admin_name: 'Admin 1',
    created_at: '2026-05-15 10:00:00',
  });

  const transferRow = formatActivationHistoryEntry({
    code: 'XYZ789',
    event_type: 'transfer',
    from_username: 'sponsor1',
    to_username: 'member2',
    actor_username: 'sponsor1',
    created_at: '2026-05-15 11:00:00',
  });

  assert.equal(releaseRow.eventLabel, 'Released');
  assert.equal(releaseRow.summary, 'Admin 1 released this code.');
  assert.equal(transferRow.eventLabel, 'Transferred');
  assert.equal(transferRow.summary, 'sponsor1 transferred this code to member2.');
});

test('activation history formatter falls back to legacy history strings when structured data is absent', () => {
  const row = formatActivationHistoryEntry({
    code: 'LEGACY1',
    legacy_history: 'admin->ver->bri',
    created_at: '2026-05-15 12:00:00',
  });

  assert.equal(row.eventLabel, 'Legacy History');
  assert.equal(row.summary, 'admin->ver->bri');
});
