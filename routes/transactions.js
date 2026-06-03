/**
 * Transaction History Routes
 * 1:1 port of PHP transactions-details.php
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { memberAuth } = require('../middleware/auth');
const { ensureVoucherTxTable } = require('../services/voucher');
const { getPairingTrace } = require('../services/income/pairingTracker');
const {
  getEffectiveAccountState,
  getAccountStateLabel,
  getAccountEntryAuditInfo,
} = require('../services/accountState');
const { getPackageClaimDetails, getPackageRewardAmounts } = require('../services/income/hifiveBonus');
const { pickRowsByExactAmount } = require('../services/transactionTrace');

function normalizeAmount(value) {
  return Number(value || 0);
}

function normalizeDateValue(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date;
}

function pickPairingRowsForTransaction(rows = [], targetAmount = 0, transdate = null) {
  return pickRowsByExactAmount(rows, targetAmount, transdate, {
    amountKey: 'creditedIncome',
    dateKey: 'pairedAt',
    maxCandidates: 24,
    maxRows: 8,
  });
}

async function resolveDirectReferralSourcesForTransaction(uid, tx) {
  const amount = normalizeAmount(tx?.directReferral);
  if (amount <= 0 || !tx) {
    return { rows: [], note: null };
  }

  const [rawRows] = await pool.query(
    `SELECT u.uid, u.directreferral AS amount, u.codeid, u.cdamount, u.cdtotal, u.cdstatus,
            DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i:%s') AS transdate,
            m.username,
            TRIM(CONCAT(COALESCE(m.firstname, ''), ' ', COALESCE(m.lastname, ''))) AS fullname
       FROM usertab u
       LEFT JOIN memberstab m ON m.uid = u.uid
      WHERE u.drefid = ?
        AND u.directreferral > 0
      ORDER BY u.datereg DESC, u.uid DESC`,
    [uid]
  ).catch(() => [[]]);

  const rows = [];
  for (const row of rawRows) {
    const effectiveRow = await getEffectiveAccountState(row.uid, row).catch(() => row);
    const auditInfo = getAccountEntryAuditInfo(effectiveRow || row);
    if (!auditInfo.sponsorCreditEligible) {
      continue;
    }

    rows.push({
      uid: Number(row.uid || 0),
      amount: normalizeAmount(effectiveRow?.directreferral || row.amount),
      transdate: row.transdate,
      username: row.username || null,
      fullname: row.fullname || row.username || `UID ${row.uid}`,
      entryType: auditInfo.entryLabel || 'Unknown',
    });
  }

  const picked = pickRowsByExactAmount(rows, amount, tx.transdate, {
    amountKey: 'amount',
    dateKey: 'transdate',
    maxCandidates: 20,
    maxRows: 6,
  });

  return {
    rows: picked.map((row) => ({
      uid: Number(row.uid || 0),
      username: row.username || null,
      fullname: row.fullname || row.username || `UID ${row.uid}`,
      entryType: row.entryType || 'Unknown',
      amount: normalizeAmount(row.amount),
      transdate: row.transdate,
    })),
    note: picked.length === 0
      ? 'This payout row does not preserve a perfect direct-referral contributor chain in every legacy case, so only exact amount matches are shown.'
      : null,
  };
}

async function resolveHiFiveSourcesForTransaction(uid, tx) {
  const amount = normalizeAmount(tx?.hifive);
  if (amount <= 0 || !tx) {
    return { claims: [], summary: null };
  }

  const rewardAmounts = await getPackageRewardAmounts().catch(() => ({}));
  const [rows] = await pool.query(
    `SELECT qualification_uid, package_or_product, qualifying_count, status, created_at, updated_at
       FROM hifive_qualificationstab
      WHERE member_uid = ?
        AND hifive_type = 'package'
        AND status = 'paid'
      ORDER BY updated_at DESC, created_at DESC`,
    [uid]
  ).catch(() => [[]]);

  if (!rows.length) {
    return { claims: [], summary: null };
  }

  const txDate = normalizeDateValue(tx.transdate);
  const candidates = rows
    .map((row) => {
      const packageKey = String(row.package_or_product || '').toLowerCase();
      const payout = normalizeAmount(rewardAmounts[packageKey]) * normalizeAmount(row.qualifying_count || 0);
      const updatedAt = normalizeDateValue(row.updated_at || row.created_at);
      const timeDistance = txDate && updatedAt ? Math.abs(updatedAt.getTime() - txDate.getTime()) : Number.MAX_SAFE_INTEGER;
      return { ...row, payout, timeDistance };
    })
    .filter((row) => row.payout === amount)
    .sort((left, right) => left.timeDistance - right.timeDistance);

  if (!candidates.length) {
    return { claims: [], summary: null };
  }

  const details = await getPackageClaimDetails(candidates[0].qualification_uid).catch(() => null);
  if (!details) {
    return { claims: [], summary: null };
  }

  return {
    claims: details.contributors || [],
    summary: details.summary || null,
  };
}

/**
 * GET /api/transactions?page=1
 * Get transaction history for logged-in member
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = req.session.uid;
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 30;
    const offset = (page - 1) * perPage;

    await ensureVoucherTxTable();

    const [[incomeCountRows], [voucherCountRows]] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM payouthistorytab WHERE uid = ?', [uid]),
      pool.query('SELECT COUNT(*) as total FROM voucher_transactionstab WHERE uid = ?', [uid]),
    ]);

    const totalIncomeRows = Number(incomeCountRows[0]?.total || 0);
    const totalVoucherRows = Number(voucherCountRows[0]?.total || 0);
    const total = totalIncomeRows + totalVoucherRows;

    const [rows] = await pool.query(
      `SELECT t.pid, t.uid, t.beginningbalance, t.endingbalance,
              t.income1, t.income2, t.income3, t.income4, t.income5, t.income6,
              t.encashment1, t.tax, t.fee, t.cddeduction,
              t.cashstatus, t.cashtransdate, t.transdate,
              t.transactiontype, t.processid,
              t.cash_paid, t.voucher_used, t.total_value, t.voucher_id
       FROM (
         SELECT CAST(p.pid AS CHAR) AS pid,
                p.uid,
                p.beginningbalance,
                p.endingbalance,
                p.income1, p.income2, p.income3, p.income4, p.income5, p.income6,
                p.encashment1,
                p.tax_1 AS tax,
                p.encashmentfee AS fee,
                p.cddeduction,
                p.cashstatus,
                DATE_FORMAT(p.cashtransdate, '%Y-%m-%d %H:%i') AS cashtransdate,
                DATE_FORMAT(p.transdate, '%Y-%m-%d %H:%i') AS transdate,
                p.transactiontype,
                p.processid,
                0 AS cash_paid,
                0 AS voucher_used,
                0 AS total_value,
                0 AS voucher_id,
                COALESCE(p.transdate, p.cashtransdate) AS sort_date,
                p.pid AS sort_id
         FROM payouthistorytab p
         WHERE p.uid = ?

         UNION ALL

         SELECT CONCAT('V-', vt.id) AS pid,
                vt.uid,
                0 AS beginningbalance,
                0 AS endingbalance,
                0 AS income1,
                0 AS income2,
                0 AS income3,
                0 AS income4,
                0 AS income5,
                0 AS income6,
                0 AS encashment1,
                0 AS tax,
                0 AS fee,
                0 AS cddeduction,
                0 AS cashstatus,
                DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS cashtransdate,
                DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS transdate,
                11 AS transactiontype,
                NULL AS processid,
                vt.cash_paid,
                vt.voucher_used,
                vt.total_value,
                vt.voucher_id,
                vt.transaction_date AS sort_date,
                vt.id AS sort_id
         FROM voucher_transactionstab vt
         WHERE vt.uid = ?
       ) t
       ORDER BY t.sort_date DESC, t.sort_id DESC
       LIMIT ?, ?`,
      [uid, uid, offset, perPage]
    );

    const transactions = rows.map(r => ({
      pid: r.pid,
      beginningBalance: Number(r.beginningbalance || 0),
      endingBalance: Number(r.endingbalance || 0),
      directReferral: Number(r.income1 || 0),
      pairing: Number(r.income2 || 0),
      leadership: Number(r.income3 || 0),
      unilevel: Number(r.income4 || 0),
      hifive: Number(r.income5 || 0),
      rankingBonus: Number(r.income6 || 0),
      encashment: Number(r.encashment1 || 0),
      tax: Number(r.tax || 0),
      fee: Number(r.fee || 0),
      cdDeduction: Number(r.cddeduction || 0),
      cashPaid: Number(r.cash_paid || 0),
      voucherUsed: Number(r.voucher_used || 0),
      totalProductValue: Number(r.total_value || 0),
      voucherId: Number(r.voucher_id || 0),
      deductions: Number(r.tax || 0) + Number(r.fee || 0) + Number(r.cddeduction || 0),
      cashStatus: Number(r.cashstatus || 0),
      transactionType: Number(r.transactiontype || 0),
      transactionTypeName:
        Number(r.transactiontype || 0) === 1
          ? 'Income'
          : Number(r.transactiontype || 0) === 10
            ? 'Encashment'
            : Number(r.transactiontype || 0) === 11
              ? 'Voucher'
            : 'Other',
      transdate: r.transdate,
      cashtransdate: r.cashtransdate,
    }));

    res.json({
      transactions,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    });
  } catch (err) {
    console.error('[Transactions] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:pid', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const pid = String(req.params.pid || '');

    await ensureVoucherTxTable();

    const [rows] = await pool.query(
      `SELECT t.pid, t.uid, t.beginningbalance, t.endingbalance,
              t.income1, t.income2, t.income3, t.income4, t.income5, t.income6,
              t.encashment1, t.tax, t.fee, t.cddeduction,
              t.cashstatus, t.cashtransdate, t.transdate,
              t.transactiontype, t.processid,
              t.cash_paid, t.voucher_used, t.total_value, t.voucher_id
       FROM (
         SELECT CAST(p.pid AS CHAR) AS pid,
                p.uid,
                p.beginningbalance,
                p.endingbalance,
                p.income1, p.income2, p.income3, p.income4, p.income5, p.income6,
                p.encashment1,
                p.tax_1 AS tax,
                p.encashmentfee AS fee,
                p.cddeduction,
                p.cashstatus,
                DATE_FORMAT(p.cashtransdate, '%Y-%m-%d %H:%i') AS cashtransdate,
                DATE_FORMAT(p.transdate, '%Y-%m-%d %H:%i') AS transdate,
                p.transactiontype,
                p.processid,
                0 AS cash_paid,
                0 AS voucher_used,
                0 AS total_value,
                0 AS voucher_id
         FROM payouthistorytab p
         WHERE p.uid = ?
         UNION ALL
         SELECT CONCAT('V-', vt.id) AS pid,
                vt.uid,
                0 AS beginningbalance,
                0 AS endingbalance,
                0 AS income1,
                0 AS income2,
                0 AS income3,
                0 AS income4,
                0 AS income5,
                0 AS income6,
                0 AS encashment1,
                0 AS tax,
                0 AS fee,
                0 AS cddeduction,
                0 AS cashstatus,
                DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS cashtransdate,
                DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS transdate,
                11 AS transactiontype,
                NULL AS processid,
                vt.cash_paid,
                vt.voucher_used,
                vt.total_value,
                vt.voucher_id
         FROM voucher_transactionstab vt
         WHERE vt.uid = ?
       ) t
       WHERE t.pid = ?
       LIMIT 1`,
      [uid, uid, pid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found.' });
    }

    const row = rows[0];
    const effectiveAccount = await getEffectiveAccountState(uid);
    const hasPairingIncome = Number(row.income2 || 0) > 0;
    const [pairingTrace, hiFiveTrace, directReferralTrace] = await Promise.all([
      hasPairingIncome
        ? getPairingTrace(uid, Number(req.session.currentaccttype || req.session.accttype || 0), { limit: 40 }).catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
      resolveHiFiveSourcesForTransaction(uid, {
        hifive: row.income5,
        transdate: row.transdate,
        processid: row.processid,
      }),
      resolveDirectReferralSourcesForTransaction(uid, {
        directReferral: row.income1,
        transdate: row.transdate,
      }),
    ]);

    const exactPairingRows = pickPairingRowsForTransaction(pairingTrace.rows || [], row.income2, row.transdate);

    res.json({
      transaction: {
        pid: row.pid,
        beginningBalance: Number(row.beginningbalance || 0),
        endingBalance: Number(row.endingbalance || 0),
        directReferral: Number(row.income1 || 0),
        pairing: Number(row.income2 || 0),
        leadership: Number(row.income3 || 0),
        unilevel: Number(row.income4 || 0),
        hifive: Number(row.income5 || 0),
        rankingBonus: Number(row.income6 || 0),
        encashment: Number(row.encashment1 || 0),
        tax: Number(row.tax || 0),
        fee: Number(row.fee || 0),
        cdDeduction: Number(row.cddeduction || 0),
        cashPaid: Number(row.cash_paid || 0),
        voucherUsed: Number(row.voucher_used || 0),
        totalProductValue: Number(row.total_value || 0),
        voucherId: Number(row.voucher_id || 0),
        deductions: Number(row.tax || 0) + Number(row.fee || 0) + Number(row.cddeduction || 0),
        cashStatus: Number(row.cashstatus || 0),
        transactionType: Number(row.transactiontype || 0),
        processKey: row.processid || null,
        transactionTypeName:
          Number(row.transactiontype || 0) === 1
            ? 'Income'
            : Number(row.transactiontype || 0) === 10
              ? 'Encashment'
              : Number(row.transactiontype || 0) === 11
                ? 'Voucher'
                : 'Other',
        transdate: row.transdate,
        cashtransdate: row.cashtransdate,
      },
      account: {
        uid,
        entryState: getAccountStateLabel(effectiveAccount),
        cdAmount: Number(effectiveAccount?.cdamount || 0),
        cdTotal: Number(effectiveAccount?.cdtotal || 0),
        cdStatus: Number(effectiveAccount?.cdstatus || 0),
      },
      supporting: {
        directReferrals: directReferralTrace.rows || [],
        leadershipSources: [],
        pairingTrace: exactPairingRows,
        hiFiveSources: hiFiveTrace.claims || [],
        hiFiveSummary: hiFiveTrace.summary || null,
        unilevelSources: [],
        rankingSources: [],
        notes: {
          directReferrals: directReferralTrace.note,
          leadershipSources: Number(row.income3 || 0) > 0 ? 'This payout row does not store exact per-record leadership source rows yet, so unrelated names are intentionally hidden.' : null,
          pairingTrace: Number(row.income2 || 0) > 0 && exactPairingRows.length === 0 ? 'Pairing income exists on this record, but exact contributor rows were not fully preserved in the legacy ledger for this payout.' : null,
          hiFiveSources: Number(row.income5 || 0) > 0 && (hiFiveTrace.claims || []).length === 0 ? 'Hi-Five income exists on this record, but the exact paid claim source could not be matched from the current legacy data.' : null,
          unilevelSources: Number(row.income4 || 0) > 0 ? 'This payout row does not store exact per-record unilevel contributors yet, so unrelated names are intentionally hidden.' : null,
          rankingSources: Number(row.income6 || 0) > 0 ? 'This payout row does not store exact per-record ranking contributors yet, so unrelated names are intentionally hidden.' : null,
        },
      },
    });
  } catch (err) {
    console.error('[Transactions] Detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
