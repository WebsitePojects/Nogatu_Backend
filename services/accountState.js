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
        accountRow.cdamount = 0;
        accountRow.cdtotal = 0;
        accountRow.cdstatus = 0;
      } else if (accountRow.upgrade_codetype === 2) {
        accountRow.codeid = 2;
        accountRow.cdamount = 0;
        accountRow.cdtotal = 0;
        accountRow.cdstatus = 0;
      } else if (accountRow.upgrade_codetype === 3) {
        accountRow.codeid = 3;
        accountRow.cdamount = accountRow.upgrade_productamount;
        accountRow.cdtotal = 0;
        accountRow.cdstatus = 1;
      }
    }
  }

  return accountRow;
}

function countsForPairingSource(row) {
  if (!row) return false;

  if (toNumber(row.codeid) === 1) {
    return true;
  }

  if (toNumber(row.codeid) === 3 && isCdFullyPaid(row)) {
    return true;
  }

  return false;
}

function countsForDirectReferralSource(row) {
  if (!row) return false;

  if (toNumber(row.codeid) === 1) {
    return true;
  }

  if (toNumber(row.codeid) === 3 && isCdFullyPaid(row)) {
    return true;
  }

  return false;
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
    return {
      entryCode: 'CD',
      entryLabel: 'CD Unpaid',
      sponsorCreditEligible: false,
      sourceBinaryEligible: false,
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
};
