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
const { getUnilevelProductPointContributors } = require('../services/income/unilevel');
const { pickRowsByExactAmount } = require('../services/transactionTrace');

// First/last day of the calendar month containing dateStr (unilevel is monthly,
// so a payout's contributors are that payout-month's downline product points).
function monthRangeOf(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = d.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = new Date(y, m + 1, 0).getDate();
  return { start: `${y}-${pad(m + 1)}-01`, end: `${y}-${pad(m + 1)}-${pad(lastDay)}` };
}

// Unilevel contributors for a payout: the downline product-point repurchases in
// the payout's month, compressed to the member's package reach. Real downline data
// (no fabrication); empty + note when legacy import lacks per-event repurchase rows.
async function resolveUnilevelSourcesForTransaction(uid, tx) {
  const amount = normalizeAmount(tx?.unilevel);
  if (amount <= 0 || !tx) return { rows: [], note: null };
  const range = monthRangeOf(tx.transdate);
  const result = await getUnilevelProductPointContributors(
    uid, range ? { start: range.start, end: range.end } : {}
  ).catch(() => ({ rows: [] }));
  const rows = (result.rows || []).map((r) => ({
    uid: Number(r.uid || 0),
    username: r.username || null,
    fullname: r.fullname || r.username || `UID ${r.uid}`,
    level: Number(r.level || 0),
    ratePercent: Number(r.ratePercent || 0),
    productName: r.productName || null,
    productPoints: Number(r.productPoints || 0),
    amount: Number(r.amount || r.projectedAmount || 0),
    transdate: r.transdate,
  }));
  return {
    rows,
    note: rows.length === 0
      ? 'Unilevel income exists on this record, but no qualifying downline product-point contributors were found for that month (e.g. legacy import without per-event repurchase rows).'
      : 'Unilevel contributors are your downline product-point repurchases for this payout’s month, compressed to your package reach; each amount is that contributor’s unilevel share.',
  };
}

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

// Direct lookup via income_eventstab → pairing_ledgerstab → binary_point_eventstab.
// Returns pair events credited around this transaction's timestamp; the caller then
// narrows them to the exact subset that sums to this payout's pairing amount so the
// trace shows only the pairs that actually made up THIS transaction. The window is
// computed in SQL (DATE_* intervals) against the raw transdate so a minute-truncated
// payout timestamp does not exclude an event credited a few seconds into that minute.
async function getPairingTraceForTransactionDirect(uid, transdate, targetAmount) {
  try {
    const [rows] = await pool.query(
      `SELECT ie.gross_amount AS creditedIncome,
              ie.credited_at AS pairedAt,
              pl.pair_points AS pairPoints,
              m_l.username AS leftUsername,
              TRIM(CONCAT(COALESCE(m_l.firstname,''),' ',COALESCE(m_l.lastname,''))) AS leftFullName,
              m_r.username AS rightUsername,
              TRIM(CONCAT(COALESCE(m_r.firstname,''),' ',COALESCE(m_r.lastname,''))) AS rightFullName
         FROM income_eventstab ie
         LEFT JOIN pairing_ledgerstab pl ON pl.ledger_uid = ie.source_ref_uid
         LEFT JOIN binary_point_eventstab bpe_l ON bpe_l.event_uid = pl.left_event_uid
         LEFT JOIN binary_point_eventstab bpe_r ON bpe_r.event_uid = pl.right_event_uid
         LEFT JOIN memberstab m_l ON m_l.uid = bpe_l.source_member_uid
         LEFT JOIN memberstab m_r ON m_r.uid = bpe_r.source_member_uid
        WHERE ie.beneficiary_uid = ?
          AND ie.income_type = 'pairing_bonus'
          AND ie.status = 'credited'
          AND ie.credited_at >= DATE_SUB(?, INTERVAL 8 DAY)
          AND ie.credited_at <= DATE_ADD(?, INTERVAL 5 MINUTE)
        ORDER BY ie.credited_at DESC`,
      [uid, transdate, transdate]
    );

    // Normalize to the same shape buildPairingHistoryRows produces so the frontend needs no changes.
    return rows.map((row) => ({
      creditedIncome: Number(row.creditedIncome || 0),
      pairPoints: Number(row.pairPoints || 0),
      pairedAt: row.pairedAt,
      left: {
        username: row.leftUsername || null,
        fullName: row.leftFullName || row.leftUsername || 'Unknown',
      },
      right: {
        username: row.rightUsername || null,
        fullName: row.rightFullName || row.rightUsername || 'Unknown',
      },
    }));
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return null;
    throw err;
  }
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

  // Add a 5-min buffer to the cutoff so a referral whose datereg lands a few
  // seconds into the payout minute isn't excluded by minute-truncation (which
  // would wrongly fall back to an earlier referral, e.g. root02 instead of root03).
  const drCutoff = (() => {
    const base = new Date(tx.transdate);
    if (Number.isNaN(base.getTime())) return tx.transdate;
    return new Date(base.getTime() + 5 * 60 * 1000);
  })();
  const picked = pickRowsByExactAmount(rows, amount, drCutoff, {
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
    // Responsive page size: frontend sends 50 (mobile) or 100 (desktop). Clamp.
    const perPage = Math.min(100, Math.max(10, Number(req.query.perPage) || 30));
    const offset = (page - 1) * perPage;

    // Filters: type (all|income|encashment|voucher), search (date substring),
    // sort (date|amount), dir (asc|desc). Default: newest first.
    const typeMap = { income: 1, encashment: 10, voucher: 11 };
    const typeFilter = typeMap[String(req.query.type || '').toLowerCase()] || null;
    const search = String(req.query.search || '').trim().slice(0, 40);
    const sortCol = String(req.query.sort || 'date').toLowerCase() === 'amount' ? 't.sort_amount' : 't.sort_date';
    const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    await ensureVoucherTxTable();

    // Shared UNION sub-select (income + voucher) with sort_amount for sorting.
    const unionSql = `(
      SELECT CAST(p.pid AS CHAR) AS pid, p.uid,
             p.beginningbalance, p.endingbalance,
             p.income1, p.income2, p.income3, p.income4, p.income5, p.income6,
             p.encashment1, p.tax_1 AS tax, p.encashmentfee AS fee, p.cddeduction, p.cashstatus,
             DATE_FORMAT(p.cashtransdate, '%Y-%m-%d %H:%i') AS cashtransdate,
             DATE_FORMAT(p.transdate, '%Y-%m-%d %H:%i') AS transdate,
             p.transactiontype, p.processid,
             0 AS cash_paid, 0 AS voucher_used, 0 AS total_value, 0 AS voucher_id,
             COALESCE(p.transdate, p.cashtransdate) AS sort_date, p.pid AS sort_id,
             (COALESCE(p.income1,0)+COALESCE(p.income2,0)+COALESCE(p.income3,0)+COALESCE(p.income4,0)
              +COALESCE(p.income5,0)+COALESCE(p.income6,0)+COALESCE(p.encashment1,0)) AS sort_amount
      FROM payouthistorytab p WHERE p.uid = ?
      UNION ALL
      SELECT CONCAT('V-', vt.id) AS pid, vt.uid,
             0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
             DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS cashtransdate,
             DATE_FORMAT(vt.transaction_date, '%Y-%m-%d %H:%i') AS transdate,
             11 AS transactiontype, NULL AS processid,
             vt.cash_paid, vt.voucher_used, vt.total_value, vt.voucher_id,
             vt.transaction_date AS sort_date, vt.id AS sort_id,
             vt.total_value AS sort_amount
      FROM voucher_transactionstab vt WHERE vt.uid = ?
    ) t`;

    const whereParts = [];
    const whereParams = [];
    if (typeFilter !== null) { whereParts.push('t.transactiontype = ?'); whereParams.push(typeFilter); }
    if (search) { whereParts.push('t.transdate LIKE ?'); whereParams.push(`%${search}%`); }
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';

    const [[countRows], [rows]] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total FROM ${unionSql} ${whereSql}`, [uid, uid, ...whereParams]),
      pool.query(
        `SELECT t.pid, t.uid, t.beginningbalance, t.endingbalance,
                t.income1, t.income2, t.income3, t.income4, t.income5, t.income6,
                t.encashment1, t.tax, t.fee, t.cddeduction,
                t.cashstatus, t.cashtransdate, t.transdate,
                t.transactiontype, t.processid,
                t.cash_paid, t.voucher_used, t.total_value, t.voucher_id
         FROM ${unionSql} ${whereSql}
         ORDER BY ${sortCol} ${dir}, t.sort_id ${dir}
         LIMIT ?, ?`,
        [uid, uid, ...whereParams, offset, perPage]
      ),
    ]);
    const total = Number(countRows[0]?.total || 0);

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
      perPage,
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
              t.cashstatus, t.cashtransdate, t.transdate, t.transdate_full,
              t.transactiontype, t.processid,
              t.cash_paid, t.voucher_used, t.total_value, t.voucher_id,
              t.availment_id, t.source_type
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
                p.transdate AS transdate_full,
                p.transactiontype,
                p.processid,
                0 AS cash_paid,
                0 AS voucher_used,
                0 AS total_value,
                0 AS voucher_id,
                NULL AS availment_id,
                NULL AS source_type
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
                vt.transaction_date AS transdate_full,
                11 AS transactiontype,
                NULL AS processid,
                vt.cash_paid,
                vt.voucher_used,
                vt.total_value,
                vt.voucher_id,
                vt.availment_id,
                vt.source_type
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

    // Voucher product detail: voucher_transactionstab.availment_id -> voucher_availmentstab.id
    // -> voucher_availment_itemstab. Shows what was bought, per-line amounts, who/when, and
    // whether the availment was a cashier (manual) or member-side request.
    let voucherDetail = null;
    if (Number(row.transactiontype || 0) === 11 && row.availment_id != null) {
      try {
        const [avRows] = await pool.query(
          `SELECT a.id AS availment_id, a.er_number, a.request_source, a.claim_status,
                  a.total_amount, a.created_by_admin, a.claimed_by_admin,
                  DATE_FORMAT(a.availment_date, '%Y-%m-%d %H:%i') AS availment_date
             FROM voucher_availmentstab a
            WHERE a.id = ? AND a.uid = ? LIMIT 1`,
          [row.availment_id, uid]
        );
        const av = avRows[0];
        if (av) {
          const [items] = await pool.query(
            `SELECT line_no, item_label, amount, product_code, product_key
               FROM voucher_availment_itemstab
              WHERE availment_id = ? ORDER BY line_no ASC, id ASC`,
            [av.availment_id]
          );
          const isCashier = String(row.source_type || av.request_source) === 'manual_availment'
            || String(av.request_source) === 'cashier';
          voucherDetail = {
            source: isCashier ? 'Cashier (manual transaction)' : 'Member-side request',
            requestSource: av.request_source,
            sourceType: row.source_type || null,
            erNumber: av.er_number || null,
            claimStatus: av.claim_status || null,
            availmentDate: av.availment_date,
            processedByAdmin: av.created_by_admin || av.claimed_by_admin || null,
            items: items.map((i) => ({
              lineNo: Number(i.line_no || 0),
              label: i.item_label,
              amount: Number(i.amount || 0),
              productCode: i.product_code != null ? Number(i.product_code) : null,
              productKey: i.product_key || null,
            })),
            itemsTotal: items.reduce((sum, i) => sum + Number(i.amount || 0), 0),
          };
        }
      } catch (vErr) {
        console.error('[Transactions] voucher detail error:', vErr.message);
      }
    }

    // Try direct income_eventstab → pairing_ledgerstab link first (exact, non-overlapping).
    // Fall back to the legacy heuristic only when the ledger tables don't exist yet.
    // Use the full-precision transdate (with seconds) so a pair credited a few seconds
    // into the payout minute is not lost to truncation.
    const pairingCutoffBase = row.transdate_full || row.transdate;
    let directPairingRows = null;
    if (hasPairingIncome) {
      directPairingRows = await getPairingTraceForTransactionDirect(
        uid, pairingCutoffBase, Number(row.income2 || 0)
      );
    }

    const [pairingTrace, hiFiveTrace, directReferralTrace, unilevelTrace] = await Promise.all([
      hasPairingIncome && directPairingRows === null
        ? getPairingTrace(uid, Number(req.session.currentaccttype || req.session.accttype || 0), { limit: 40 }).catch(() => ({ rows: [] }))
        : Promise.resolve({ rows: [] }),
      resolveHiFiveSourcesForTransaction(uid, {
        hifive: row.income5,
        transdate: row.transdate,
        processid: row.processid,
      }),
      resolveDirectReferralSourcesForTransaction(uid, {
        directReferral: row.income1,
        transdate: row.transdate_full || row.transdate,
      }),
      resolveUnilevelSourcesForTransaction(uid, {
        unilevel: row.income4,
        transdate: row.transdate_full || row.transdate,
      }),
    ]);

    // Narrow the direct ledger rows to the exact subset that sums to THIS payout's
    // pairing amount, preferring the events closest to the payout timestamp. Without
    // this, every pair event in the lookback window would be shown even though this
    // single transaction only credited one (or a few) of them.
    const pairingCutoff = (() => {
      const base = new Date(pairingCutoffBase);
      if (Number.isNaN(base.getTime())) return row.transdate;
      return new Date(base.getTime() + 5 * 60 * 1000);
    })();
    const exactPairingRows = directPairingRows !== null
      ? pickRowsByExactAmount(directPairingRows, Number(row.income2 || 0), pairingCutoff, {
          amountKey: 'creditedIncome',
          dateKey: 'pairedAt',
          maxCandidates: 24,
          maxRows: 8,
        })
      : pickPairingRowsForTransaction(pairingTrace.rows || [], row.income2, row.transdate);

    // Pairing income is a cumulative Math.max delta, so an exact per-payout amount
    // match often fails. Rather than show "no contributors", fall back to the matched
    // -pair events closest to (and not after) this payout — the likely triggers
    // (e.g. the member just placed in the weak leg) — clearly labelled approximate.
    let pairingRowsOut = exactPairingRows;
    let pairingApprox = false;
    if (pairingRowsOut.length === 0 && Number(row.income2 || 0) > 0) {
      const cutoffMs = new Date(pairingCutoff).getTime();
      const pool = (directPairingRows && directPairingRows.length ? directPairingRows : (pairingTrace.rows || []));
      const near = pool
        .filter((r) => { const t = new Date(r.pairedAt).getTime(); return !Number.isNaN(t) && t <= cutoffMs; })
        .sort((a, b) => new Date(b.pairedAt) - new Date(a.pairedAt))
        .slice(0, 8);
      if (near.length > 0) { pairingRowsOut = near; pairingApprox = true; }
    }

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
      voucherDetail,
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
        pairingTrace: pairingRowsOut,
        hiFiveSources: hiFiveTrace.claims || [],
        hiFiveSummary: hiFiveTrace.summary || null,
        unilevelSources: unilevelTrace.rows || [],
        rankingSources: [],
        notes: {
          directReferrals: directReferralTrace.note,
          leadershipSources: Number(row.income3 || 0) > 0 ? 'This payout row does not store exact per-record leadership source rows yet, so unrelated names are intentionally hidden.' : null,
          pairingTrace: Number(row.income2 || 0) > 0 && pairingRowsOut.length === 0
            ? 'Pairing income exists on this record, but exact contributor rows were not fully preserved in the legacy ledger for this payout.'
            : (pairingApprox ? 'Approximate attribution: the matched-pair events closest to this payout (who most likely triggered this pairing).' : null),
          hiFiveSources: Number(row.income5 || 0) > 0 && (hiFiveTrace.claims || []).length === 0 ? 'Hi-Five income exists on this record, but the exact paid claim source could not be matched from the current legacy data.' : null,
          unilevelSources: Number(row.income4 || 0) > 0 ? unilevelTrace.note : null,
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
