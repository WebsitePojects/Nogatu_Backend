const { pool } = require('../config/database');

function toNumber(value) {
  return Number(value || 0);
}

function isCdFullyPaid(row) {
  if (!row) return false;
  const cdAmount = toNumber(row.cdamount);
  const cdTotal = toNumber(row.cdtotal);
  const cdStatus = toNumber(row.cdstatus);

  if (cdStatus !== 2) return false;
  if (cdAmount <= 0) return true;
  return cdTotal >= cdAmount;
}

async function getLatestUpgradeCode(uid, executor) {
  const runner = executor || pool;
  const [rows] = await runner.query(
    `SELECT u.uid,
            u.producttype,
            u.codeid AS upgradecodeid,
            c.codetype,
            c.productamount
       FROM upgradetab u
       INNER JOIN codestab c ON u.codeid = c.id
      WHERE u.uid = ?
        AND u.transtype = 1
      ORDER BY u.transdate DESC, u.id DESC
      LIMIT 1`,
    [uid]
  );

  return rows[0] || null;
}

async function getEffectiveAccountState(uid, row, executor) {
  const runner = executor || pool;
  let accountRow = row && typeof row === 'object' ? { ...row } : null;

  const requiredFields = [
    'uid',
    'accttype',
    'currentaccttype',
    'codeid',
    'cdamount',
    'cdtotal',
    'cdstatus',
  ];

  let needsRefresh = !accountRow;
  if (!needsRefresh) {
    for (const field of requiredFields) {
      if (typeof accountRow[field] === 'undefined') {
        needsRefresh = true;
        break;
      }
    }
  }

  if (needsRefresh) {
    const [rows] = await runner.query(
      `SELECT uid, accttype, currentaccttype, codeid, cdamount, cdtotal, cdstatus
         FROM usertab
        WHERE uid = ?
        LIMIT 1`,
      [uid]
    );

    if (rows.length === 0) {
      return null;
    }

    accountRow = {
      ...(accountRow || {}),
      ...rows[0],
    };
  }

  accountRow.raw_codeid = toNumber(accountRow.codeid);
  accountRow.raw_cdamount = toNumber(accountRow.cdamount);
  accountRow.raw_cdtotal = toNumber(accountRow.cdtotal);
  accountRow.raw_cdstatus = toNumber(accountRow.cdstatus);
  accountRow.upgrade_codetype = 0;
  accountRow.upgrade_productamount = 0;

  if (toNumber(accountRow.accttype) < toNumber(accountRow.currentaccttype)) {
    const upgrade = await getLatestUpgradeCode(uid, runner);

    if (upgrade) {
      accountRow.upgrade_codetype = toNumber(upgrade.codetype);
      accountRow.upgrade_productamount = toNumber(upgrade.productamount);

      if (accountRow.upgrade_codetype === 1) {
        accountRow.codeid = 1;

        if (accountRow.raw_codeid === 3) {
          accountRow.cdamount = accountRow.raw_cdamount;
          accountRow.cdtotal = Math.max(accountRow.raw_cdtotal, accountRow.raw_cdamount);
          accountRow.cdstatus = 2;
        } else {
          accountRow.cdamount = 0;
          accountRow.cdtotal = 0;
          accountRow.cdstatus = 0;
        }
      } else if (accountRow.upgrade_codetype === 2) {
        accountRow.codeid = 2;
        accountRow.cdamount = 0;
        accountRow.cdtotal = 0;
        accountRow.cdstatus = 0;
      } else if (accountRow.upgrade_codetype === 3) {
        accountRow.codeid = 3;

        if (
          accountRow.raw_codeid === 3 &&
          accountRow.raw_cdamount === accountRow.upgrade_productamount
        ) {
          accountRow.cdamount = accountRow.raw_cdamount;
          accountRow.cdtotal = accountRow.raw_cdtotal;
          accountRow.cdstatus = accountRow.raw_cdstatus;
        } else {
          accountRow.cdamount = accountRow.upgrade_productamount;
          accountRow.cdtotal = 0;
          accountRow.cdstatus = 1;
        }
      }
    }
  }

  return accountRow;
}

// Sir Dino, 2026-11-23 ("4 Paid Accounts"): these members registered with CD codes but were
// recorded as PAID. They are converted to unpaid CD (package kept) so their own encashments repay
// the obligation (insertIncome deducts on codeid 3 + cdstatus 1). Their uplines must keep earning
// exactly as before, so while they are CD they still count as direct-referral and pairing sources:
// pairing contribution, pairing unlock, leadership source, Hi-Five sets. Once the CD is fully paid
// they count anyway, so nothing changes for the uplines at payoff (no offset to retire, no double pay).
// Keyed by uid AND codeid 3: the exception only applies to these four while they are CD.
const UPLINE_NEUTRAL_CD_UIDS = Object.freeze([6581504, 4584545, 5658589, 3933627]);
const UPLINE_NEUTRAL_CD_SET = new Set(UPLINE_NEUTRAL_CD_UIDS);

function isUplineNeutralCd(row) {
  return Boolean(row) && toNumber(row.codeid) === 3 && UPLINE_NEUTRAL_CD_SET.has(toNumber(row.uid));
}

function countsForPairingSource(row) {
  if (!row) return false;

  if (toNumber(row.codeid) === 1) {
    return true;
  }

  if (toNumber(row.codeid) === 3 && isCdFullyPaid(row)) {
    return true;
  }

  return isUplineNeutralCd(row);
}

function countsForDirectReferralSource(row) {
  if (!row) return false;

  if (toNumber(row.codeid) === 1) {
    return true;
  }

  if (toNumber(row.codeid) === 3 && isCdFullyPaid(row)) {
    return true;
  }

  return isUplineNeutralCd(row);
}

function getAccountStateLabel(row) {
  if (!row) return 'Unknown';

  const codeid = toNumber(row.codeid);
  const cdPaid = isCdFullyPaid(row);

  if (codeid === 1) return 'PD';
  if (codeid === 2) return 'FS';
  if (codeid === 3 && cdPaid) return 'CD - Paid';
  if (codeid === 3) return 'CD';
  return 'Unknown';
}

function getAccountEntryAuditInfo(row) {
  if (!row) {
    return {
      entryCode: 'UNKNOWN',
      entryLabel: 'Unknown',
      sponsorCreditEligible: false,
      sourceBinaryEligible: false,
    };
  }

  const codeid = toNumber(row.codeid);
  const cdPaid = isCdFullyPaid(row);

  if (codeid === 1) {
    return {
      entryCode: 'PD',
      entryLabel: 'Paid Direct',
      sponsorCreditEligible: true,
      sourceBinaryEligible: true,
    };
  }

  if (codeid === 2) {
    return {
      entryCode: 'FS',
      entryLabel: 'Free Slot',
      sponsorCreditEligible: false,
      sourceBinaryEligible: false,
    };
  }

  if (codeid === 3 && cdPaid) {
    return {
      entryCode: 'CD-PAID',
      entryLabel: 'CD Settled',
      sponsorCreditEligible: true,
      sourceBinaryEligible: true,
    };
  }

  if (codeid === 3) {
    const neutral = isUplineNeutralCd(row);
    return {
      entryCode: 'CD',
      entryLabel: 'CD Unpaid',
      sponsorCreditEligible: neutral,
      sourceBinaryEligible: neutral,
    };
  }

  return {
    entryCode: 'UNKNOWN',
    entryLabel: 'Unknown',
    sponsorCreditEligible: false,
    sourceBinaryEligible: false,
  };
}

module.exports = {
  getLatestUpgradeCode,
  getEffectiveAccountState,
  isCdFullyPaid,
  countsForPairingSource,
  countsForDirectReferralSource,
  getAccountStateLabel,
  getAccountEntryAuditInfo,
  isUplineNeutralCd,
  UPLINE_NEUTRAL_CD_UIDS,
};
