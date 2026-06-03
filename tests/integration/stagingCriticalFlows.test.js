const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

const repoRoot = path.resolve(__dirname, '..', '..');

function resolveEnvFile() {
  const candidates = ['.env.development', '.env.dev', '.env.prod'];
  for (const file of candidates) {
    const absolute = path.join(repoRoot, file);
    if (fs.existsSync(absolute)) return absolute;
  }
  return null;
}

const envFile = resolveEnvFile();
if (envFile) {
  dotenv.config({ path: envFile });
}

const { pool } = require(path.join(repoRoot, 'config', 'database.js'));

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5001';
const adminUsername = process.env.SMOKE_ADMIN_USERNAME || 'nogatuadmin';
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD || '1';
const sponsorUsername = process.env.SMOKE_MEMBER_USERNAME || 'nogatumain';
const sponsorPassword = process.env.SMOKE_MEMBER_PASSWORD || '12345678';

class SessionClient {
  constructor(rootUrl) {
    this.rootUrl = rootUrl.replace(/\/+$/, '');
    this.cookies = new Map();
  }

  _storeCookies(response) {
    const rawSetCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    const fallback = response.headers.get('set-cookie');
    const values = rawSetCookies.length > 0
      ? rawSetCookies
      : (fallback ? [fallback] : []);

    for (const value of values) {
      const first = String(value || '').split(';')[0];
      const eqIndex = first.indexOf('=');
      if (eqIndex <= 0) continue;
      const name = first.slice(0, eqIndex).trim();
      const cookieValue = first.slice(eqIndex + 1).trim();
      this.cookies.set(name, cookieValue);
    }
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(method, route, { json, expect = 'json', headers = {} } = {}) {
    const finalHeaders = { ...headers };
    const cookie = this._cookieHeader();
    if (cookie) finalHeaders.Cookie = cookie;
    if (json !== undefined) {
      finalHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${this.rootUrl}${route}`, {
      method,
      headers: finalHeaders,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });

    this._storeCookies(response);

    let body;
    if (expect === 'text') {
      body = await response.text();
    } else {
      const text = await response.text();
      body = text ? JSON.parse(text) : null;
    }

    return {
      status: response.status,
      headers: response.headers,
      body,
    };
  }
}

async function assertOkJson(client, method, route, options = {}) {
  const result = await client.request(method, route, options);
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${route} expected 2xx, got ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function assertStatus(client, method, route, expectedStatus, options = {}) {
  const result = await client.request(method, route, options);
  assert.equal(result.status, expectedStatus, `${method} ${route} expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function queryOne(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

async function ensureWalletBalance(uid, amount) {
  await pool.query(
    `INSERT INTO payouttotaltab
     (uid, mainid, ttlincome1, ttlincome2, ttlincome3, ttlincome4, ttlincome5, ttlincome51, ttlincome6, ttlcashbalance, ttlpointsbalance, transdate)
     VALUES (?, NULL, 0, 0, 0, 0, 0, 0, 0, ?, 0, NOW())
     ON DUPLICATE KEY UPDATE ttlcashbalance = VALUES(ttlcashbalance), transdate = VALUES(transdate)`,
    [uid, amount]
  );
}

if (process.env.RUN_STAGING_SMOKE === '1') {
  test.after(async () => {
    await pool.end();
  });
}

test('authenticated staging smoke covers registration, upgrade, wallet, vouchers, pairing, ranking, Hi-Five, and admin finance', {
  skip: process.env.RUN_STAGING_SMOKE !== '1',
  timeout: 180000,
}, async (t) => {
  t.diagnostic(`smoke base url: ${baseUrl}`);
  const probe = await fetch(`${baseUrl}/health`);
  assert.equal(probe.status, 200, `Smoke target ${baseUrl} is not healthy`);

  const adminClient = new SessionClient(baseUrl);
  const sponsorClient = new SessionClient(baseUrl);

  const adminLogin = await assertOkJson(adminClient, 'POST', '/api/admin/auth/login', {
    json: { username: adminUsername, password: adminPassword },
  });
  assert.equal(adminLogin.success, true);

  const sponsorLogin = await assertOkJson(sponsorClient, 'POST', '/api/auth/login', {
    json: { username: sponsorUsername, password: sponsorPassword },
  });
  assert.equal(sponsorLogin.success, true);

  const referralLink = await assertOkJson(sponsorClient, 'GET', '/api/registration/referral-link');
  assert.ok(referralLink.slug, 'Referral slug should be returned');
  const slug = String(referralLink.slug || '').trim();
  assert.ok(slug, 'Referral slug should be present');

  const generatedCd = await assertOkJson(adminClient, 'POST', '/api/admin/codes/generate', {
    json: { noOfCodes: 1, productType: 10, codeType: 3 },
  });
  const generatedUpgrade = await assertOkJson(adminClient, 'POST', '/api/admin/codes/generate', {
    json: { noOfCodes: 1, productType: 30, codeType: 1 },
  });

  const cdCode = generatedCd.codes[0];
  const upgradeCode = generatedUpgrade.codes[0];
  assert.ok(cdCode && upgradeCode, 'Generated codes should be returned');

  const sponsorTransfer = await assertOkJson(adminClient, 'POST', '/api/admin/codes/release-transfer', {
    json: { targetUsername: sponsorUsername, codes: [cdCode] },
  });
  assert.equal(sponsorTransfer.transferred, 1);

  const publicReferral = new SessionClient(baseUrl);
  const invitePayload = await assertOkJson(publicReferral, 'GET', `/api/registration/referral/${slug}`);
  assert.equal(invitePayload.invite.reusable, true);

  const stamp = Date.now();
  const newUsername = `SmokeCD${stamp}`;
  const memberEmail = `smoke.${stamp}@example.com`;
  const memberPassword = 'SmokePass123';
  const memberAddress = `Smoke Street ${stamp}`;
  const memberContact = `09${String(stamp).slice(-9)}`;
  const memberDob = '1993-04-15';

  const registration = await assertOkJson(publicReferral, 'POST', '/api/registration/public-register', {
    json: {
      slug,
      activationCode: cdCode,
      username: newUsername,
      password: memberPassword,
      firstname: 'Smoke',
      lastname: `Tester${String(stamp).slice(-4)}`,
      middlename: 'CD',
      email: memberEmail,
      address: memberAddress,
      contactno: memberContact,
      dob: memberDob,
    },
  });
  assert.equal(registration.success, true);
  t.diagnostic(`registered smoke user: ${newUsername}`);

  const registeredAccount = await queryOne(
    `SELECT u.uid, u.currentaccttype, u.codeid, u.cdstatus, u.cdamount, u.cdtotal
       FROM usertab u
       INNER JOIN memberstab m ON m.uid = u.uid
      WHERE m.username = ?
      LIMIT 1`,
    [newUsername]
  );
  assert.ok(registeredAccount, 'Registered member should exist in the database');
  assert.equal(Number(registeredAccount.codeid), 3);
  assert.equal(Number(registeredAccount.cdstatus), 1);
  assert.equal(Number(registeredAccount.cdtotal || 0), 0);
  assert.ok(Number(registeredAccount.cdamount || 0) > 0);

  const newMemberClient = new SessionClient(baseUrl);
  const newMemberLogin = await assertOkJson(newMemberClient, 'POST', '/api/auth/login', {
    json: { username: newUsername, password: memberPassword },
  });
  assert.equal(newMemberLogin.success, true);

  const missingTinPreview = await assertStatus(newMemberClient, 'POST', '/api/wallet/preview-encash', 422, {
    json: { amount: 100 },
  });
  assert.equal(missingTinPreview.code, 'TIN_REQUIRED_FOR_ENCASHMENT');

  const upgradeTransfer = await assertOkJson(adminClient, 'POST', '/api/admin/codes/release-transfer', {
    json: { targetUsername: newUsername, codes: [upgradeCode] },
  });
  assert.equal(upgradeTransfer.transferred, 1);

  const upgradeResult = await assertOkJson(newMemberClient, 'POST', '/api/codes/upgrade', {
    json: { code: upgradeCode },
  });
  assert.equal(upgradeResult.success, true);
  assert.equal(Number(upgradeResult.newAccountType), 30);

  const upgradedAccount = await queryOne(
    `SELECT currentaccttype, codeid, cdstatus, cdamount, cdtotal
       FROM usertab
      WHERE uid = ?
      LIMIT 1`,
    [registeredAccount.uid]
  );
  assert.equal(Number(upgradedAccount.currentaccttype), 30);
  assert.equal(Number(upgradedAccount.codeid), 1);
  assert.equal(Number(upgradedAccount.cdstatus), 0);

  const accountBeforeUpdate = await assertOkJson(newMemberClient, 'GET', '/api/account');
  assert.equal(accountBeforeUpdate.username, newUsername);

  const accountUpdate = await assertOkJson(newMemberClient, 'PUT', '/api/account', {
    json: {
      address: memberAddress,
      payoutdetails: '09171234567',
      payoutoptions: 1,
      contactnos: memberContact,
      tin: '123-456-789',
      email: memberEmail,
    },
  });
  assert.equal(accountUpdate.success, true);

  await ensureWalletBalance(registeredAccount.uid, 500);

  const walletSummary = await assertOkJson(newMemberClient, 'GET', '/api/wallet');
  assert.ok(Object.prototype.hasOwnProperty.call(walletSummary, 'rankingBonus'));
  assert.ok(Object.prototype.hasOwnProperty.call(walletSummary, 'cashBalance'));

  const vouchers = await assertOkJson(newMemberClient, 'GET', '/api/vouchers');
  assert.ok(Array.isArray(vouchers.vouchers), 'Voucher list should be returned');
  const activeVoucher = vouchers.vouchers.find((voucher) => Number(voucher.status) === 1 && Number(voucher.remaining_balance || 0) > 0);
  assert.ok(activeVoucher, 'Registration should issue an active voucher');

  const redeem = await assertOkJson(newMemberClient, 'POST', '/api/vouchers/redeem', {
    json: {
      voucherId: activeVoucher.id,
      cashAmount: 100,
      productKey: 'bl',
    },
  });
  assert.equal(redeem.success, true);
  assert.ok(Number(redeem.walletBalance || 0) >= 0);

  const pairing = await assertOkJson(newMemberClient, 'GET', '/api/pairing');
  assert.ok(pairing.eligibility);

  const ranking = await assertOkJson(newMemberClient, 'GET', '/api/ranking');
  assert.ok(Object.prototype.hasOwnProperty.call(ranking, 'currentRank'));

  const rankingExplain = await assertOkJson(newMemberClient, 'GET', '/api/ranking/explain');
  assert.ok(rankingExplain);

  const hifive = await assertOkJson(newMemberClient, 'GET', '/api/hifive');
  assert.ok(hifive.productBonus);
  assert.ok(hifive.packageBonus);

  const encashPreview = await assertOkJson(newMemberClient, 'POST', '/api/wallet/preview-encash', {
    json: { amount: 200 },
  });
  assert.equal(encashPreview.success, true);
  assert.ok(Number(encashPreview.preview.net || 0) > 0);

  const encashSubmit = await assertOkJson(newMemberClient, 'POST', '/api/wallet/encash', {
    json: { amount: 200 },
  });
  assert.equal(encashSubmit.success, true);
  assert.ok(Number(encashSubmit.pid || 0) > 0);
  t.diagnostic(`encashment pid: ${encashSubmit.pid}`);

  const adminEncashment = await assertOkJson(adminClient, 'GET', '/api/admin/encashment');
  const pendingRow = (adminEncashment.records || []).find((row) => Number(row.pid) === Number(encashSubmit.pid));
  assert.ok(pendingRow, 'Admin encashment list should include the submitted payout');

  const processEncashment = await assertOkJson(adminClient, 'PUT', `/api/admin/encashment/${encashSubmit.pid}/process`, {
    json: { uid: registeredAccount.uid },
  });
  assert.equal(processEncashment.success, true);

  const adminFinance = await assertOkJson(adminClient, 'GET', '/api/admin/finance');
  assert.ok(adminFinance.totals);
  assert.ok(adminFinance.wallets);

  const financeExport = await adminClient.request('GET', '/api/admin/finance/export', { expect: 'text' });
  assert.equal(financeExport.status, 200);
  assert.match(String(financeExport.headers.get('content-type') || ''), /text\/csv/i);
  assert.match(String(financeExport.body), /Finance Summary/);
});
