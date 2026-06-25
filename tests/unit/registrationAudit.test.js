const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendPlacementAudit,
  appendActivationCodeUsage,
} = require('../../services/registrationAudit');

test('appendPlacementAudit records requested and enforced positions', async () => {
  const calls = [];
  const conn = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };

  await appendPlacementAudit(conn, {
    sponsorUid: 1001,
    placementUid: 2002,
    createdUid: 3003,
    requestedPosition: 2,
    enforcedPosition: 1,
    policyMode: 'forced',
    policyReason: 'root-sponsor-default-left',
    referralToken: 'abc123',
    processKey: 'placement:test:1',
  });

  assert.match(calls[0].sql, /INSERT INTO binary_placement_audittab/i);
  assert.deepEqual(calls[0].params.slice(0, 8), [
    1001, 2002, 3003, 2, 1, 'forced', 'root-sponsor-default-left', 'abc123',
  ]);
});

test('appendActivationCodeUsage records structured code lifecycle events', async () => {
  const calls = [];
  const conn = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };

  await appendActivationCodeUsage(conn, {
    code: 'PD1234567890',
    codeRowId: 55,
    eventType: 'registration-used',
    fromUid: 1001,
    toUid: 3003,
    actorUid: 1001,
    actorAdminId: null,
    referralToken: 'slug123',
    registrationUid: 3003,
    upgradeUid: null,
    notes: { placementUid: 2002 },
    processKey: 'code:test:1',
  });

  // Insert is idempotent (INSERT IGNORE) so a re-run can't dup-key the usage row.
  assert.match(calls[0].sql, /INSERT(\s+IGNORE)?\s+INTO activation_code_usagetab/i);
  assert.equal(calls[0].params[0], 'PD1234567890');
  assert.equal(calls[0].params[2], 'registration-used');
  assert.equal(calls[0].params[8], 3003);
});
