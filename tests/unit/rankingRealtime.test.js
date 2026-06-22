const test = require('node:test');
const assert = require('node:assert/strict');

test('outbox publishes targeted member and global leaderboard invalidations', async () => {
  const { publishOutboxRow } = require('../../services/rankingRealtime');
  const calls = [];
  await publishOutboxRow({
    event_uid: 'evt-1',
    repurchase_id: 501,
    affected_member_uids: JSON.stringify([90, 80]),
    created_at: '2026-06-22T02:00:00.000Z',
  }, {
    publishToUser: (uid, event, payload) => calls.push([uid, event, payload.memberUid]),
    publishToAllUsers: (event) => calls.push(['all', event]),
    publishToAdmins: (event) => calls.push(['admins', event]),
  });

  assert.deepEqual(calls, [
    [90, 'ranking.member.updated', 90],
    [80, 'ranking.member.updated', 80],
    ['all', 'ranking.leaderboard.updated'],
    ['admins', 'ranking.leaderboard.updated'],
  ]);
});

test('malformed outbox affected members are safely treated as an empty list', async () => {
  const { publishOutboxRow } = require('../../services/rankingRealtime');
  const calls = [];
  await publishOutboxRow({ event_uid: 'evt-2', repurchase_id: 502, affected_member_uids: 'bad-json' }, {
    publishToUser: () => calls.push('member'),
    publishToAllUsers: () => calls.push('all'),
    publishToAdmins: () => calls.push('admins'),
  });
  assert.deepEqual(calls, ['all', 'admins']);
});
