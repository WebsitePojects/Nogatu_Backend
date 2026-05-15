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

      return [{ affectedRows: 1 }];
    },
  };

  const codeData = await consumeActivationCodeForRegistration(conn, {
    activationCode: 'CDQVF123',
    sponsorUid: 9001,
  });

  assert.equal(codeData.producttype, 40);
  assert.deepEqual(calls[0].params, ['CDQVF123', 9001]);
  assert.deepEqual(calls[1].params, ['CDQVF123', 9001]);
  assert.match(calls[1].sql, /codestatus = 2/i);
  assert.doesNotMatch(calls[1].sql.split(/WHERE/i)[0], /uid\s*=\s*\?/i);
});

test('registration rejects activation codes that cannot be consumed for the sponsor', async () => {
  let step = 0;
  const conn = {
    query: async () => {
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
