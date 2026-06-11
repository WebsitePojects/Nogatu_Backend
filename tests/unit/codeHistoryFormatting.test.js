const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatActivationHistoryEntry,
} = require('../../services/codeHistory');

test('activation history formatter exposes generator, release, and transfer actors clearly', () => {
  const generatedRow = formatActivationHistoryEntry({
    code: 'GEN123',
    event_type: 'generated',
    code_processid: 'nogatucashier',
    created_at: '2026-06-11 20:00:00',
  });

  const releaseRow = formatActivationHistoryEntry({
    code: 'ABC123',
    event_type: 'release',
    actor_admin_name: 'nogatucashier',
    created_at: '2026-06-11 20:05:00',
  });

  const transferRow = formatActivationHistoryEntry({
    code: 'XYZ789',
    event_type: 'admin_transfer',
    from_username: 'nogatucashier',
    to_username: '00001',
    actor_admin_name: 'nogatucashier',
    created_at: '2026-06-11 20:10:00',
  });

  assert.equal(generatedRow.eventLabel, 'Generated');
  assert.equal(generatedRow.summary, 'nogatucashier generated this code.');
  assert.equal(releaseRow.eventLabel, 'Released');
  assert.equal(releaseRow.summary, 'nogatucashier released this code.');
  assert.equal(transferRow.eventLabel, 'Admin Transfer');
  assert.equal(transferRow.summary, 'nogatucashier transferred this code to 00001.');
});

test('activation history formatter turns legacy transfer chains into readable summaries', () => {
  const row = formatActivationHistoryEntry({
    code: 'LEGACY1',
    legacy_history: '(nogatuadmin)Ann050890 -> (Ann050890)Malou05',
    datetransfer: '2026-06-11 20:15:00',
  });

  assert.equal(row.eventLabel, 'Transfer History');
  assert.match(row.summary, /currently held by Malou05/i);
  assert.match(row.summary, /nogatuadmin/i);
});
