/**
 * Pairing Reports Routes
 * 1:1 port of PHP pairing-reports.php
 */
const express = require('express');
const router = express.Router();
const { memberAuth } = require('../middleware/auth');
const { pool } = require('../config/database');
const { getPairingCounts } = require('../services/network');
const {
  backfillHistoricalBinaryPointEvents,
  getPairingTrace,
  getPairingLegAccounts,
  buildPairingHistoryRows,
} = require('../services/income/pairingTracker');
const { getPackagePolicy } = require('../services/packagePolicy');
const { getEffectiveAccountState, countsForPairingSource, getAccountStateLabel } = require('../services/accountState');
const { getBinaryPairingEligibility } = require('../services/binaryEligibility');

router.get('/sources', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
    await backfillHistoricalBinaryPointEvents(uid).catch((error) => {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    });

    try {
      const [rows] = await pool.query(
        `SELECT bpe.event_uid, bpe.source_member_uid, bpe.parent_uid, c.leg AS owner_leg,
                bpe.event_type, bpe.package_type, bpe.point_value,
                bpe.reference_key, bpe.event_ts,
                m.username, m.firstname, m.lastname
         FROM binary_tree_closuretab c
         INNER JOIN binary_point_eventstab bpe ON bpe.source_member_uid = c.descendant_uid
         LEFT JOIN memberstab m ON m.uid = bpe.source_member_uid
         WHERE c.ancestor_uid = ? AND c.depth > 0 AND c.leg IN ('left', 'right') AND bpe.deleted_at IS NULL
         ORDER BY bpe.event_ts DESC, bpe.id DESC
         LIMIT ?`,
        [uid, limit]
      );

      return res.json({
        source: 'binary_point_eventstab',
        formula: 'Each row is a binary point event triggered by a downline account or qualifying upgrade, grouped by your left or right leg.',
        rows: rows.map((row) => ({
          ...row,
          leg: row.owner_leg,
          point_value: Number(row.point_value || 0),
          full_name: `${row.firstname || ''} ${row.lastname || ''}`.trim(),
        })),
        asOf: new Date().toISOString(),
      });
    } catch (error) {
      if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
    }

    const [rows] = await pool.query(
      `SELECT id, totalleft, totalright, totalpointsleft, totalpointsright,
              \`left\` AS left_balance, \`right\` AS right_balance, transdate
       FROM pairingstab
       WHERE uid = ?
       ORDER BY id DESC
       LIMIT ?`,
      [uid, limit]
    );
    res.json({
      source: 'pairingstab_fallback',
      formula: 'Ledger tables are not migrated yet; showing latest pairing snapshots.',
      rows,
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Pairing] Sources error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/leg/:side', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const accttype = Number(req.session.currentaccttype || req.session.accttype || 0);
    const side = req.params.side === 'right' ? 'right' : 'left';
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Math.max(10, Number(req.query.perPage) || 50));
    const payload = await getPairingLegAccounts(uid, accttype, side, { page, perPage });

    res.json({
      side,
      page: payload.pagination.page,
      perPage: payload.pagination.perPage,
      totalPages: payload.pagination.totalPages,
      total: payload.pagination.totalRows,
      summary: payload.summary,
      rows: payload.rows,
      formula: side === 'left'
        ? 'These are the current left-leg pairing source accounts under your subtree, grouped by source account and ordered by level.'
        : 'These are the current right-leg pairing source accounts under your subtree, grouped by source account and ordered by level.',
      asOf: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Pairing] Leg detail error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/pairing
 * Get pairing report data
 */
router.get('/', memberAuth, async (req, res) => {
  try {
    const uid = Number(req.session.uid);
    const accttype = Number(req.session.currentaccttype || req.session.accttype || 0);
    const packagePolicy = getPackagePolicy(accttype);
    const effectiveAccount = await getEffectiveAccountState(uid);
    const sourceEligible = countsForPairingSource(effectiveAccount);
    const historyPage = Math.max(1, Number(req.query.historyPage || req.query.page) || 1);
    const historyPerPage = Math.min(100, Math.max(10, Number(req.query.historyPerPage || req.query.perPage) || 50));
    const tracePage = Math.max(1, Number(req.query.tracePage) || 1);
    const tracePerPage = Math.min(100, Math.max(10, Number(req.query.tracePerPage) || 50));
    // History table standard: search (date or source username), sort (date|amount), dir.
    const historySearch = String(req.query.historySearch || '').trim().toLowerCase().slice(0, 40);
    const historySort = String(req.query.historySort || 'date').toLowerCase() === 'amount' ? 'amount' : 'date';
    const historyDir = String(req.query.historyDir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    // Event Trace has its OWN independent search (separate from History's).
    const traceSearch = String(req.query.traceSearch || '').trim().toLowerCase().slice(0, 40);

    const [counts, trace, walletRows, binaryEligibility] = await Promise.all([
      getPairingCounts(uid),
      getPairingTrace(uid, accttype, { page: tracePage, perPage: tracePerPage, traceSearch })
        .catch((error) => {
          if (error.code === 'ER_NO_SUCH_TABLE') {
            return {
              rows: [],
              summary: {
                totalEvents: 0,
                totalPairPoints: 0,
                totalGrossIncome: 0,
                totalCreditedIncome: 0,
                lockedEvents: 0,
                cappedEvents: 0,
                uncappedEvents: 0,
              },
              weeklyCap: 0,
              packageName: null,
              sourceBackfill: { inserted: 0, skipped: 0 },
              pagination: { page: 1, perPage: tracePerPage, totalRows: 0, totalPages: 1 },
            };
          }
          throw error;
        }),
      pool.query('SELECT ttlincome2 FROM payouttotaltab WHERE uid = ? LIMIT 1', [uid])
        .then(([rows]) => rows)
        .catch(() => []),
      getBinaryPairingEligibility(uid).catch(() => ({
        canEarnPairing: true,
        leftQualifiedCount: 0,
        rightQualifiedCount: 0,
        leftQualified: false,
        rightQualified: false,
        missingLegs: [],
        qualifyingDirects: { left: [], right: [] },
        reason: null,
      })),
    ]);

    const walletPairingTotal = Number(walletRows[0]?.ttlincome2 || 0);
    const balances = trace?.balances || {};

    // Build history from the new ledger (income_eventstab).
    const ledgerHistoryRows = buildPairingHistoryRows(trace?.allRows || trace?.rows || []);

    // If the new ledger has no credited events, fall back to the historical PHP records
    // stored in payouthistorytab.income2 so members can always see their full history.
    let historyRowsAll = ledgerHistoryRows;
    if (ledgerHistoryRows.length === 0) {
      const [legacyRows] = await pool.query(
        `SELECT pid, uid, transdate, income2
           FROM payouthistorytab
          WHERE uid = ? AND income2 > 0
          ORDER BY transdate DESC`,
        [uid]
      );
      if (legacyRows.length > 0) {
        historyRowsAll = legacyRows.map((row) => ({
          historyUid: `legacy-${row.pid}`,
          pairedAt: row.transdate,
          matchedPoints: null,
          creditedIncome: Number(row.income2 || 0),
          left: null,
          right: null,
          leftRemainingAfter: null,
          rightRemainingAfter: null,
          isLegacy: true,
        }));
      }
    }

    // Search: match the formatted date or either source username.
    let historyFiltered = historyRowsAll;
    if (historySearch) {
      historyFiltered = historyRowsAll.filter((r) => {
        const hay = `${String(r.pairedAt || '')} ${String(r.left?.username || '')} ${String(r.right?.username || '')}`.toLowerCase();
        return hay.includes(historySearch);
      });
    }
    // Sort by date or credited amount, with matchSeq as the deterministic
    // tiebreaker. Many pairs share the same paired_at (a late-joining strong-leg
    // source "forms" all its pairs at once), so without matchSeq the sort is
    // unstable and the rows — and their decrementing "source remaining" — jumble.
    // matchSeq is the true chronological order each pair was consumed.
    const dirMul = historyDir === 'asc' ? 1 : -1;
    historyFiltered = [...historyFiltered].sort((a, b) => {
      if (historySort === 'amount') {
        const d = Number(a.creditedIncome || 0) - Number(b.creditedIncome || 0);
        if (d !== 0) return d * dirMul;
        return (Number(a.matchSeq || 0) - Number(b.matchSeq || 0)) * dirMul;
      }
      const d = new Date(a.pairedAt || 0) - new Date(b.pairedAt || 0);
      if (d !== 0) return d * dirMul;
      return (Number(a.matchSeq || 0) - Number(b.matchSeq || 0)) * dirMul;
    });

    const historyTotal = Number(historyFiltered.length || 0);
    const historyTotalPages = Math.max(1, Math.ceil(historyTotal / historyPerPage));
    const safeHistoryPage = Math.min(historyTotalPages, Math.max(1, historyPage));
    const historyOffset = (safeHistoryPage - 1) * historyPerPage;
    const historyRows = historyFiltered.slice(historyOffset, historyOffset + historyPerPage);
    // totalPointsLeft/Right come from getPairingCounts — full recursive usertab
    // traversal of all eligible PD/fully-paid-CD accounts. This is the authoritative
    // source and matches what the dashboard displays. Do NOT override with the
    // new ledger's availableLeftPoints which is only correct after full backfill.
    const displayCounts = {
      ...counts,
      pairedPointsConsumed: Number(balances.pairedPoints || 0),
      strongLegPoints: Number(balances.strongLegPoints || 0),
      weakLegPoints: Number(balances.weakLegPoints || 0),
    };

    res.json({
      history: {
        rows: historyRows,
        page: safeHistoryPage,
        perPage: historyPerPage,
        total: historyTotal,
        totalPages: historyTotalPages,
      },
      counts: displayCounts,
      trace,
      packagePolicy,
      walletPairingTotal,
      eligibility: {
        canEarnPairing: Boolean(binaryEligibility.canEarnPairing),
        sourceEligible,
        accountState: getAccountStateLabel(effectiveAccount),
        reason: binaryEligibility.reason || null,
        qualifiedDirects: {
          left: Number(binaryEligibility.leftQualifiedCount || 0),
          right: Number(binaryEligibility.rightQualifiedCount || 0),
        },
        missingLegs: binaryEligibility.missingLegs || [],
        sourceReason: sourceEligible
          ? null
          : 'This account cannot pass its own BP to its sponsor and uplines yet, but it can still receive SMB from eligible paid or fully paid CD downlines when both sides of the subtree have qualified BP.',
        rule: 'Binary pairing income is earned whenever eligible BP exists on both the left and right legs of your subtree. All account types (PD, FS, CD) can receive pairing income.',
      },
    });
  } catch (err) {
    console.error('[Pairing] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
