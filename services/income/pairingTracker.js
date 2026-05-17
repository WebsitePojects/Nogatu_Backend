const { pool } = require('../../config/database');
const { getEffectiveAccountState, countsForPairingSource } = require('../accountState');
const { ACCOUNT_TYPES } = require('../../utils/helpers');
const { createProcessKey, createPublicId } = require('../../utils/security');
const { PAIRING_CAPS } = require('./pairing');
const { getPackagePairingMonthlyCap, getPackageSealingPoint } = require('../packagePolicy');

const PAIRING_PESO_PER_POINT = 250;

function toNumber(value) {
  return Number(value || 0);
}

function toIsoTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function weekKeyForTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - (utcDate.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

function normalizeTrackerEvent(row, ownerLegOverride = null) {
  const eventTs = toIsoTimestamp(row.event_ts || row.eventTs || row.datereg || row.transdate);
  return {
    eventUid: row.event_uid || row.eventUid,
    sourceMemberUid: toNumber(row.source_member_uid ?? row.sourceMemberUid ?? row.uid),
    ownerLeg: ownerLegOverride || row.owner_leg || row.ownerLeg || row.leg || 'unknown',
    pointValue: toNumber(row.point_value ?? row.pointValue ?? row.binarypoints),
    eventType: row.event_type || row.eventType || 'registration',
    packageType: row.package_type || row.packageType || null,
    referenceKey: row.reference_key || row.referenceKey || null,
    eventTs,
    username: row.username || null,
    fullName: row.full_name || row.fullName || row.name || row.username || `UID ${row.source_member_uid || row.uid}`,
  };
}

function buildPairingLedgerEntries({ ownerUid, accttype, leftEvents = [], rightEvents = [] }) {
  const weeklyCap = toNumber(PAIRING_CAPS[accttype] || PAIRING_CAPS[10] || 10000);
  const monthlyCap = toNumber(getPackagePairingMonthlyCap(accttype) || 0);
  const sealingPoint = toNumber(getPackageSealingPoint(accttype) || 0);
  const leftQueue = leftEvents
    .map((row) => ({ ...normalizeTrackerEvent(row, 'left'), remainingPoints: toNumber(row.point_value ?? row.pointValue ?? row.binarypoints) }))
    .filter((row) => row.pointValue > 0 && row.eventUid && row.eventTs)
    .sort((a, b) => new Date(a.eventTs) - new Date(b.eventTs) || String(a.eventUid).localeCompare(String(b.eventUid)));
  const rightQueue = rightEvents
    .map((row) => ({ ...normalizeTrackerEvent(row, 'right'), remainingPoints: toNumber(row.point_value ?? row.pointValue ?? row.binarypoints) }))
    .filter((row) => row.pointValue > 0 && row.eventUid && row.eventTs)
    .sort((a, b) => new Date(a.eventTs) - new Date(b.eventTs) || String(a.eventUid).localeCompare(String(b.eventUid)));

  const weeklyCredits = new Map();
  const monthlyCredits = new Map();
  const ledgerRows = [];
  let leftIndex = 0;
  let rightIndex = 0;
  let totalCredited = 0;

  while (leftIndex < leftQueue.length && rightIndex < rightQueue.length) {
    const leftEvent = leftQueue[leftIndex];
    const rightEvent = rightQueue[rightIndex];
    const pairPoints = Math.min(toNumber(leftEvent.remainingPoints), toNumber(rightEvent.remainingPoints));

    if (pairPoints <= 0) {
      if (toNumber(leftEvent.remainingPoints) <= 0) leftIndex += 1;
      if (toNumber(rightEvent.remainingPoints) <= 0) rightIndex += 1;
      continue;
    }

    const pairedAt = new Date(Math.max(new Date(leftEvent.eventTs).getTime(), new Date(rightEvent.eventTs).getTime())).toISOString();
    const pairingWeekKey = weekKeyForTimestamp(pairedAt);
    const pairingMonthKey = String(pairedAt).slice(0, 7);
    const weekCredited = toNumber(weeklyCredits.get(pairingWeekKey) || 0);
    const monthCredited = toNumber(monthlyCredits.get(pairingMonthKey) || 0);
    const grossIncome = pairPoints * PAIRING_PESO_PER_POINT;
    const capRemaining = Math.max(0, weeklyCap - weekCredited);
    const monthRemaining = monthlyCap > 0 ? Math.max(0, monthlyCap - monthCredited) : grossIncome;
    const sealRemaining = sealingPoint > 0 ? Math.max(0, sealingPoint - totalCredited) : grossIncome;
    const creditedIncome = Math.min(grossIncome, capRemaining, monthRemaining, sealRemaining);

    if (creditedIncome > 0) {
      weeklyCredits.set(pairingWeekKey, weekCredited + creditedIncome);
      if (monthlyCap > 0) {
        monthlyCredits.set(pairingMonthKey, monthCredited + creditedIncome);
      }
      totalCredited += creditedIncome;
    }

    ledgerRows.push({
      ledgerUid: createProcessKey(['pairing-ledger', ownerUid, leftEvent.eventUid, rightEvent.eventUid]),
      ownerUid: toNumber(ownerUid),
      leftEventUid: leftEvent.eventUid,
      rightEventUid: rightEvent.eventUid,
      pairPoints,
      pairCap: weeklyCap,
      pairMonthCap: monthlyCap,
      sealingPoint,
      creditedIncome,
      grossIncome,
      capApplied: creditedIncome < grossIncome,
      pairedAt,
      weekKey: pairingWeekKey,
      leftSourceMemberUid: leftEvent.sourceMemberUid,
      rightSourceMemberUid: rightEvent.sourceMemberUid,
      leftUsername: leftEvent.username,
      rightUsername: rightEvent.username,
      leftFullName: leftEvent.fullName,
      rightFullName: rightEvent.fullName,
      leftEventType: leftEvent.eventType,
      rightEventType: rightEvent.eventType,
      leftPackageType: leftEvent.packageType,
      rightPackageType: rightEvent.packageType,
      leftReferenceKey: leftEvent.referenceKey,
      rightReferenceKey: rightEvent.referenceKey,
    });

    leftEvent.remainingPoints -= pairPoints;
    rightEvent.remainingPoints -= pairPoints;

    if (leftEvent.remainingPoints <= 0) leftIndex += 1;
    if (rightEvent.remainingPoints <= 0) rightIndex += 1;
  }

  return ledgerRows;
}

function summarizePairingTrace(rows = []) {
  return rows.reduce((summary, row) => {
    const pairPoints = toNumber(row.pairPoints);
    const grossIncome = toNumber(row.grossIncome);
    const creditedIncome = toNumber(row.creditedIncome);
    summary.totalEvents += 1;
    summary.totalPairPoints += pairPoints;
    summary.totalGrossIncome += grossIncome;
    summary.totalCreditedIncome += creditedIncome;
    if (row.capApplied) {
      summary.cappedEvents += 1;
    } else {
      summary.uncappedEvents += 1;
    }
    return summary;
  }, {
    totalEvents: 0,
    totalPairPoints: 0,
    totalGrossIncome: 0,
    totalCreditedIncome: 0,
    cappedEvents: 0,
    uncappedEvents: 0,
  });
}

async function ensureBinaryPointEventTable(conn = pool) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'binary_point_eventstab'`
  );
  return Number(rows[0]?.total || 0) > 0;
}

async function ensurePairingLedgerTable(conn = pool) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'pairing_ledgerstab'`
  );
  return Number(rows[0]?.total || 0) > 0;
}

async function ensureIncomeEventTable(conn = pool) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'income_eventstab'`
  );
  return Number(rows[0]?.total || 0) > 0;
}

async function backfillHistoricalBinaryPointEvents(ownerUid, conn = pool) {
  if (!(await ensureBinaryPointEventTable(conn))) {
    return { inserted: 0, skipped: 0 };
  }

  const [descendants] = await conn.query(
    `SELECT u.uid, u.refid, u.drefid, u.position, u.accttype, u.currentaccttype,
            u.codeid, u.cdamount, u.cdtotal, u.cdstatus, u.binarypoints,
            DATE_FORMAT(u.datereg, '%Y-%m-%d %H:%i:%s') AS datereg
       FROM binary_tree_closuretab c
       INNER JOIN usertab u ON u.uid = c.descendant_uid
      WHERE c.ancestor_uid = ?
        AND c.depth > 0
      ORDER BY c.depth ASC, u.datereg ASC, u.uid ASC`,
    [ownerUid]
  );

  let inserted = 0;
  let skipped = 0;

  for (const descendant of descendants) {
    const effectiveRow = await getEffectiveAccountState(descendant.uid, descendant, conn);
    if (!effectiveRow || !countsForPairingSource(effectiveRow)) {
      skipped += 1;
      continue;
    }

    const registrationReference = createProcessKey(['binary-point-event', 'registration', descendant.uid]);
    const registrationEventUid = createPublicId();
    const [registrationResult] = await conn.query(
      `INSERT INTO binary_point_eventstab
       (event_uid, source_member_uid, owner_uid, parent_uid, leg, event_type,
        package_type, point_value, reference_key, event_ts)
       VALUES (?, ?, ?, ?, ?, 'registration', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE event_uid = event_uid`,
      [
        registrationEventUid,
        descendant.uid,
        descendant.drefid || null,
        descendant.refid || null,
        Number(descendant.position || 0) === 1 ? 'left' : 'right',
        String(descendant.accttype || descendant.currentaccttype || ''),
        toNumber(descendant.binarypoints),
        registrationReference,
        descendant.datereg || new Date().toISOString().slice(0, 19).replace('T', ' '),
      ]
    );
    if (registrationResult.affectedRows === 1) inserted += 1;

    if (Number(descendant.accttype || 0) >= Number(descendant.currentaccttype || 0)) {
      continue;
    }

    const [upgradeRows] = await conn.query(
      `SELECT id, uid, producttype, binarypoints,
              DATE_FORMAT(transdate, '%Y-%m-%d %H:%i:%s') AS transdate
         FROM upgradetab
        WHERE uid = ?
          AND transtype = 1
        ORDER BY transdate ASC, id ASC`,
      [descendant.uid]
    );

    for (const upgrade of upgradeRows) {
      const upgradeReference = createProcessKey(['binary-point-event', 'upgrade', upgrade.id]);
      const [upgradeResult] = await conn.query(
        `INSERT INTO binary_point_eventstab
         (event_uid, source_member_uid, owner_uid, parent_uid, leg, event_type,
          package_type, point_value, reference_key, event_ts)
         VALUES (?, ?, ?, ?, ?, 'package_upgrade', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE event_uid = event_uid`,
        [
          createPublicId(),
          descendant.uid,
          descendant.drefid || null,
          descendant.refid || null,
          Number(descendant.position || 0) === 1 ? 'left' : 'right',
          String(upgrade.producttype || descendant.currentaccttype || ''),
          toNumber(upgrade.binarypoints),
          upgradeReference,
          upgrade.transdate || descendant.datereg || new Date().toISOString().slice(0, 19).replace('T', ' '),
        ]
      );
      if (upgradeResult.affectedRows === 1) inserted += 1;
    }
  }

  return { inserted, skipped };
}

async function loadOwnerBinaryPointEvents(ownerUid, conn = pool) {
  const [rows] = await conn.query(
    `SELECT bpe.id, bpe.event_uid, bpe.source_member_uid, c.leg AS owner_leg,
            bpe.event_type, bpe.package_type, bpe.point_value,
            bpe.reference_key, bpe.event_ts,
            m.username,
            TRIM(CONCAT(COALESCE(m.firstname, ''), ' ', COALESCE(m.lastname, ''))) AS full_name
       FROM binary_tree_closuretab c
       INNER JOIN binary_point_eventstab bpe
               ON bpe.source_member_uid = c.descendant_uid
              AND bpe.deleted_at IS NULL
       LEFT JOIN memberstab m ON m.uid = bpe.source_member_uid
      WHERE c.ancestor_uid = ?
        AND c.depth > 0
        AND c.leg IN ('left', 'right')
      ORDER BY bpe.event_ts ASC, bpe.id ASC`,
    [ownerUid]
  );

  return rows.map((row) => normalizeTrackerEvent(row, row.owner_leg));
}

async function syncPairingLedger(ownerUid, accttype, conn = pool) {
  if (!(await ensureBinaryPointEventTable(conn)) || !(await ensurePairingLedgerTable(conn))) {
    return { rows: [], summary: summarizePairingTrace([]), sourceBackfill: { inserted: 0, skipped: 0 } };
  }

  const sourceBackfill = await backfillHistoricalBinaryPointEvents(ownerUid, conn);
  const events = await loadOwnerBinaryPointEvents(ownerUid, conn);
  const leftEvents = events.filter((row) => row.ownerLeg === 'left');
  const rightEvents = events.filter((row) => row.ownerLeg === 'right');
  const ledgerRows = buildPairingLedgerEntries({ ownerUid, accttype, leftEvents, rightEvents });
  const hasIncomeEventTable = await ensureIncomeEventTable(conn);

  for (const row of ledgerRows) {
    let incomeEventUid = null;

    if (hasIncomeEventTable) {
      const incomeEventProcessKey = createProcessKey(['pairing-income', row.ledgerUid]);
      const incomeInsertValues = [
        createPublicId(),
        incomeEventProcessKey,
        ownerUid,
        row.ledgerUid,
        row.grossIncome,
        row.creditedIncome,
        row.pairedAt,
      ];
      try {
        await conn.query(
          `INSERT INTO income_eventstab
           (event_uid, process_key, beneficiary_uid, income_type, source_ref_uid, source_ref_type,
            gross_amount, tax_deduction, processing_fee, cd_deduction, maintenance_fee,
            net_amount, status, credited_at)
           VALUES (?, ?, ?, 'pairing_bonus', ?, 'pairing_ledger',
            ?, 0, 0, 0, 0,
            ?, 'credited', ?)
           ON DUPLICATE KEY UPDATE
             gross_amount = VALUES(gross_amount),
             net_amount = VALUES(net_amount),
             credited_at = VALUES(credited_at)`,
          incomeInsertValues
        );

        const [incomeRows] = await conn.query(
          'SELECT event_uid FROM income_eventstab WHERE process_key = ? LIMIT 1',
          [incomeEventProcessKey]
        );
        incomeEventUid = incomeRows[0]?.event_uid || null;
      } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
      }
    }

    await conn.query(
      `INSERT INTO pairing_ledgerstab
       (ledger_uid, owner_uid, left_event_uid, right_event_uid, pair_points, pair_cap,
        points_used, income_event_uid, paired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         pair_points = VALUES(pair_points),
         pair_cap = VALUES(pair_cap),
         points_used = VALUES(points_used),
         income_event_uid = COALESCE(VALUES(income_event_uid), income_event_uid),
         paired_at = VALUES(paired_at)`,
      [
        row.ledgerUid,
        ownerUid,
        row.leftEventUid,
        row.rightEventUid,
        row.pairPoints,
        row.pairCap,
        row.creditedIncome,
        incomeEventUid,
        row.pairedAt.slice(0, 19).replace('T', ' '),
      ]
    );
  }

  return {
    rows: ledgerRows,
    summary: summarizePairingTrace(ledgerRows),
    sourceBackfill,
  };
}

async function getPairingTrace(ownerUid, accttype, options = {}, conn = pool) {
  const limit = Math.min(200, Math.max(10, Number(options.limit) || 50));
  const syncResult = await syncPairingLedger(ownerUid, accttype, conn);

  if (!(await ensurePairingLedgerTable(conn))) {
    return {
      rows: [],
      summary: summarizePairingTrace([]),
      packageName: ACCOUNT_TYPES[accttype] || 'Unknown',
      weeklyCap: toNumber(PAIRING_CAPS[accttype] || 0),
      sourceBackfill: syncResult.sourceBackfill,
    };
  }

  const [rows] = await conn.query(
    `SELECT pl.ledger_uid, pl.owner_uid, pl.left_event_uid, pl.right_event_uid,
            pl.pair_points, pl.pair_cap, pl.points_used, pl.income_event_uid,
            DATE_FORMAT(pl.paired_at, '%Y-%m-%d %H:%i:%s') AS paired_at,
            l.source_member_uid AS left_source_member_uid,
            r.source_member_uid AS right_source_member_uid,
            ml.username AS left_username,
            mr.username AS right_username,
            TRIM(CONCAT(COALESCE(ml.firstname, ''), ' ', COALESCE(ml.lastname, ''))) AS left_full_name,
            TRIM(CONCAT(COALESCE(mr.firstname, ''), ' ', COALESCE(mr.lastname, ''))) AS right_full_name,
            l.event_type AS left_event_type,
            r.event_type AS right_event_type,
            l.package_type AS left_package_type,
            r.package_type AS right_package_type
       FROM pairing_ledgerstab pl
       INNER JOIN binary_point_eventstab l ON l.event_uid = pl.left_event_uid
       INNER JOIN binary_point_eventstab r ON r.event_uid = pl.right_event_uid
       LEFT JOIN memberstab ml ON ml.uid = l.source_member_uid
       LEFT JOIN memberstab mr ON mr.uid = r.source_member_uid
      WHERE pl.owner_uid = ?
      ORDER BY pl.paired_at DESC, pl.id DESC
      LIMIT ?`,
    [ownerUid, limit]
  );

  const normalizedRows = rows.map((row) => ({
    ledgerUid: row.ledger_uid,
    ownerUid: toNumber(row.owner_uid),
    pairPoints: toNumber(row.pair_points),
    pairCap: toNumber(row.pair_cap),
    pairMonthCap: syncResult.rows.find((item) => item.ledgerUid === row.ledger_uid)?.pairMonthCap || 0,
    creditedIncome: toNumber(row.points_used),
    grossIncome: toNumber(row.pair_points) * PAIRING_PESO_PER_POINT,
    blockedIncome: Math.max(0, (toNumber(row.pair_points) * PAIRING_PESO_PER_POINT) - toNumber(row.points_used)),
    capApplied: toNumber(row.points_used) < (toNumber(row.pair_points) * PAIRING_PESO_PER_POINT),
    pairedAt: row.paired_at,
    incomeEventUid: row.income_event_uid || null,
    left: {
      eventUid: row.left_event_uid,
      sourceMemberUid: toNumber(row.left_source_member_uid),
      username: row.left_username || null,
      fullName: row.left_full_name || row.left_username || `UID ${row.left_source_member_uid}`,
      eventType: row.left_event_type,
      packageType: row.left_package_type,
    },
    right: {
      eventUid: row.right_event_uid,
      sourceMemberUid: toNumber(row.right_source_member_uid),
      username: row.right_username || null,
      fullName: row.right_full_name || row.right_username || `UID ${row.right_source_member_uid}`,
      eventType: row.right_event_type,
      packageType: row.right_package_type,
    },
  }));

  return {
    rows: normalizedRows,
    summary: summarizePairingTrace(normalizedRows),
    packageName: ACCOUNT_TYPES[accttype] || 'Unknown',
    weeklyCap: toNumber(PAIRING_CAPS[accttype] || 0),
    sourceBackfill: syncResult.sourceBackfill,
  };
}

module.exports = {
  PAIRING_PESO_PER_POINT,
  normalizeTrackerEvent,
  buildPairingLedgerEntries,
  summarizePairingTrace,
  backfillHistoricalBinaryPointEvents,
  loadOwnerBinaryPointEvents,
  syncPairingLedger,
  getPairingTrace,
};
