const test = require('node:test');
const assert = require('node:assert/strict');

const {
  consumeActivationCodeForRegistration,
} = require('../../services/registration');

test('registration consumes sponsor-owned activation code without reassigning ownership', async () => {
  const calls = [];
  const conn = {
    query: async (sql, params) => {
      calls.push({ sql, params });

      if (calls.length === 1) {
        return [[{
          code: 'CDQVF123',
          uid: 9001,
          producttype: 40,
          codetype: 3,
          productamount: 5000,
          binarypoints: 2500,
          directreferral: 1000,
          incentivepoints: 300,
          profitsharing: 0,
          stockistid: 1,
        }]];
      }

      // Answer the already-used guard explicitly. Previously this fell through to
      // `[{ affectedRows: 1 }]`, which the guard read as "no member" only because
      // `.length` was undefined -- an accidental pass, not a stated intent.
      if (/membersRegistered/i.test(sql)) {
        return [[{ membersRegistered: 0, physicalRows: 1, registeredUid: null }]];
      }

      return [{ affectedRows: 1 }];
    },
  };

  const codeData = await consumeActivationCodeForRegistration(conn, {
    activationCode: 'CDQVF123',
    sponsorUid: 9001,
  });

  assert.equal(codeData.producttype, 40);
  // Code is looked up + consumed by CODE only — registration never binds it to (or
  // reassigns it from) a sponsor uid; the real registrant link lives in
  // activation_code_usagetab, not codestab.uid.
  assert.deepEqual(calls[0].params, ['CDQVF123']);

  // Located rather than indexed: an already-used guard now runs between the lookup
  // and the consuming UPDATE (services/codeConsumption.js), so a fixed position
  // would silently start asserting against the wrong statement.
  const consume = calls.find((c) => /UPDATE\s+codestab/i.test(c.sql));
  assert.ok(consume, 'the consuming UPDATE must still be issued');
  assert.deepEqual(consume.params, ['CDQVF123']);
  assert.match(consume.sql, /codestatus = 2/i);
  assert.doesNotMatch(consume.sql.split(/WHERE/i)[0], /uid\s*=\s*\?/i);
});

test('registration rejects activation codes that cannot be consumed for the sponsor', async () => {
  let step = 0;
  const conn = {
    query: async (sql) => {
      if (/membersRegistered/i.test(sql)) {
        return [[{ membersRegistered: 0, physicalRows: 1, registeredUid: null }]];
      }
      step += 1;
      if (step === 1) {
        return [[{
          code: 'CDQVF123',
          uid: 9001,
          producttype: 40,
          codetype: 3,
          productamount: 5000,
        }]];
      }

      return [{ affectedRows: 0 }];
    },
  };

  await assert.rejects(
    consumeActivationCodeForRegistration(conn, {
      activationCode: 'CDQVF123',
      sponsorUid: 9001,
    }),
    /Invalid or used activation code/
  );
});
