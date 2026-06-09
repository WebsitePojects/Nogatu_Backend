const { pool } = require('../../config/database');
const { getEffectiveAccountState, countsForPairingSource, getAccountStateLabel } = require('../accountState');
const { ACCOUNT_TYPES } = require('../../utils/helpers');
const { createProcessKey, createPublicId } = require('../../utils/security');
const { PAIRING_CAPS } = require('./pairing');
const { getPackagePairingMonthlyCap, getPackageSealingPoint } = require('../packagePolicy');
const { getBinaryPairingEligibility } = require('../binaryEligibility');

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

function paginateRows(rows = [], page = 1, perPage = 50) {
  const safePerPage = Math.min(200, Math.max(1, Number(perPage) || 50));
  const totalRows = Number(rows.length || 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / safePerPage));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const offset = (safePage - 1) * safePerPage;

  return {
    rows: rows.slice(offset, offset + safePerPage),
    pagination: {
      page: safePage,
      perPage: safePerPage,
      totalRows,
      totalPages,
    },
  };
}

function packageLabelForType(packageType) {
  const numeric = toNumber(packageType);
  return ACCOUNT_TYPES[numeric] || (numeric > 0 ? `Type ${numeric}` : 'Unknown');
}

async function buildPairingSourceMetaMap(sourceUids = [], conn = pool) {
  const uniqueUids = [...new Set((sourceUids || []).map((uid) => toNumber(uid)).filter((uid) => uid > 0))];
  if (uniqueUids.length === 0) return new Map();

  const placeholders = uniqueUids.map(() => '?').join(', ');
  const [rows] = await conn.query(
    `SELECT uid, currentaccttype, codeid, cdamount, cdtotal, cdstatus
       FROM usertab
      WHERE uid IN (${placeholders})`,
    uniqueUids
  );

  const map = new Map();
  for (const row of rows) {
    const effectiveRow = await getEffectiveAccountState(row.uid, row, conn);
    map.set(toNumber(row.uid), {
      packageType: toNumber(effectiveRow?.currentaccttype || row.currentaccttype || 0),
      packageLabel: packageLabelForType(effectiveRow?.currentaccttype || row.currentaccttype || 0),
      accountStateLabel: getAccountStateLabel(effectiveRow || row),
    });
  }

  return map;
}

function buildPairingLedgerEntries({ ownerUid, accttype, leftEvents = [], rightEvents = [], creditsLocked = false, creditsLockedReason = null }) {
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
    const grossIncome = pairPoints;
    const capRemaining = Math.max(0, weeklyCap - weekCredited);
    const monthRemaining = monthlyCap > 0 ? Math.max(0, monthlyCap - monthCredited) : grossIncome;
    const sealRemaining = sealingPoint > 0 ? Math.max(0, sealingPoint - totalCredited) : grossIncome;
    const creditedIncome = creditsLocked
      ? 0
      : Math.min(grossIncome, capRemaining, monthRemaining, sealRemaining);
    const leftPointsBefore = toNumber(leftEvent.remainingPoints);
    const rightPointsBefore = toNumber(rightEvent.remainingPoints);
    const leftRemainingAfter = Math.max(0, leftPointsBefore - pairPoints);
    const rightRemainingAfter = Math.max(0, rightPointsBefore - pairPoints);

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
      capApplied: !creditsLocked && creditedIncome < grossIncome,
      eligibilityLocked: Boolean(creditsLocked),
      eligibilityLockedReason: creditsLockedReason || null,
      pairedAt,
      weekKey: pairingWeekKey,
      pairingMonthKey,
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
      leftPointsBefore,
      rightPointsBefore,
      leftRemainingAfter,
      rightRemainingAfter,
      leftFullyConsumed: leftRemainingAfter <= 0,
      rightFullyConsumed: rightRemainingAfter <= 0,
    });

    leftEvent.remainingPoints -= pairPoints;
    rightEvent.remainingPoints -= pairPoints;

    if (leftEvent.remainingPoints <= 0) leftIndex += 1;
    if (rightEvent.remainingPoints <= 0) rightIndex += 1;
  }

  return ledgerRows;
}

function summarizePairingBalances({ leftEvents = [], rightEvents = [], ledgerRows = [] }) {
  const totalLeftPoints = leftEvents.reduce((sum, row) => sum + toNumber(row.point_value ?? row.pointValue ?? row.binarypoints ?? row.points), 0);
  const totalRightPoints = rightEvents.reduce((sum, row) => sum + toNumber(row.point_value ?? row.pointValue ?? row.binarypoints ?? row.points), 0);
  const pairedPoints = ledgerRows.reduce((sum, row) => sum + toNumber(row.pairPoints), 0);
  const availableLeftPoints = Math.max(0, totalLeftPoints - pairedPoints);
  const availableRightPoints = Math.max(0, totalRightPoints - pairedPoints);

  return {
    totalLeftPoints,
    totalRightPoints,
    pairedPoints,
    availableLeftPoints,
    availableRightPoints,
    weakLegPoints: Math.min(availableLeftPoints, availableRightPoints),
    strongLegPoints: Math.max(availableLeftPoints, availableRightPoints),
  };
}

function summarizePairingTrace(rows = []) {
  return rows.reduce((summary, row) => {
    const pairPoints = toNumber(row.pairPoints);
    const grossIncome = toNumber(row.grossIncome);
    const creditedIncome = toNumber(row.creditedIncome);
    const blockedIncome = Math.max(0, grossIncome - creditedIncome);
    summary.totalEvents += 1;
    summary.totalPairPoints += pairPoints;
    summary.totalGrossIncome += grossIncome;
    summary.totalCreditedIncome += creditedIncome;
    summary.totalBlockedIncome += blockedIncome;
    summary.totalFlushoutIncome += blockedIncome;
    summary.companyRetainedIncome += blockedIncome;
    if (row.eligibilityLocked) {
      summary.lockedEvents += 1;
    } else if (row.capApplied) {
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
    totalBlockedIncome: 0,
    totalFlushoutIncome: 0,
    companyRetainedIncome: 0,
    lockedEvents: 0,
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

  const seen = new Set();
  const events = [];

  for (const row of rows) {
    const normalized = normalizeTrackerEvent(row, row.owner_leg);
    const dedupeKey = normalized.eventType === 'registration'
      ? `registration:${normalized.sourceMemberUid}`
      : (normalized.referenceKey
        ? `${normalized.eventType}:${normalized.referenceKey}`
        : `${normalized.eventType}:${normalized.sourceMemberUid}:${normalized.packageType || ''}:${normalized.eventTs || ''}`);

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    events.push(normalized);
  }

  return events;
}

async function syncPairingLedger(ownerUid, accttype, conn = pool) {
  if (!(await ensureBinaryPointEventTable(conn)) || !(await ensurePairingLedgerTable(conn))) {
    return { rows: [], summary: summarizePairingTrace([]), sourceBackfill: { inserted: 0, skipped: 0 } };
  }

  const sourceBackfill = await backfillHistoricalBinaryPointEvents(ownerUid, conn);
  const events = await loadOwnerBinaryPointEvents(ownerUid, conn);
  const leftEvents = events.filter((row) => row.ownerLeg === 'left');
  const rightEvents = events.filter((row) => row.ownerLeg === 'right');
  const eligibility = await getBinaryPairingEligibility(ownerUid, conn);
  const ledgerRows = buildPairingLedgerEntries({
    ownerUid,
    accttype,
    leftEvents,
    rightEvents,
    creditsLocked: !eligibility.canEarnPairing,
    creditsLockedReason: eligibility.reason,
  });
  const balances = summarizePairingBalances({
    leftEvents,
    rightEvents,
    ledgerRows: eligibility.canEarnPairing ? ledgerRows : [],
  });
  const hasIncomeEventTable = await ensureIncomeEventTable(conn);

  if (!eligibility.canEarnPairing) {
    return {
      rows: ledgerRows,
      summary: summarizePairingTrace(ledgerRows),
      sourceBackfill,
      eligibility,
      balances,
      previewOnly: true,
    };
  }

  for (const row of ledgerRows) {
    let incomeEventUid = null;

    if (hasIncomeEventTable && toNumber(row.creditedIncome) > 0) {
      const incomeEventProcessKey = createProcessKey(['pairing-income', row.ledgerUid]);
      const incomeInsertValues = [
        createPublicId(),
        incomeEventProcessKey,
        ownerUid,
        row.ledgerUid,
        row.grossIncome,
        row.creditedIncome,
        String(row.pairedAt).slice(0, 19).replace('T', ' '),
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

  if (ledgerRows.length > 0) {
    const placeholders = ledgerRows.map(() => '?').join(', ');
    await conn.query(
      `DELETE FROM pairing_ledgerstab
        WHERE owner_uid = ?
          AND ledger_uid NOT IN (${placeholders})`,
      [ownerUid, ...ledgerRows.map((row) => row.ledgerUid)]
    );
  } else {
    await conn.query('DELETE FROM pairing_ledgerstab WHERE owner_uid = ?', [ownerUid]);
  }

  return {
    rows: ledgerRows,
    summary: summarizePairingTrace(ledgerRows),
    sourceBackfill,
    eligibility,
    balances,
  };
}

async function getPairingTrace(ownerUid, accttype, options = {}, conn = pool) {
  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(200, Math.max(1, Number(options.perPage) || Number(options.limit) || 50));
  const syncResult = await syncPairingLedger(ownerUid, accttype, conn);

  if (!(await ensurePairingLedgerTable(conn))) {
    return {
      rows: [],
      allRows: [],
      summary: summarizePairingTrace([]),
      packageName: ACCOUNT_TYPES[accttype] || 'Unknown',
      weeklyCap: toNumber(PAIRING_CAPS[accttype] || 0),
      sourceBackfill: syncResult.sourceBackfill,
      eligibility: syncResult.eligibility || null,
      balances: syncResult.balances || summarizePairingBalances({}),
      pagination: {
        page: 1,
        perPage,
        totalRows: 0,
        totalPages: 1,
      },
    };
  }

  if (syncResult.previewOnly) {
    const previewRows = await normalizeLedgerTraceRows(syncResult.rows, null, conn);
    const paginated = paginateRows(previewRows, page, perPage);

    return {
      rows: paginated.rows,
      allRows: previewRows,
      summary: summarizePairingTrace(previewRows),
      packageName: ACCOUNT_TYPES[accttype] || 'Unknown',
      weeklyCap: toNumber(PAIRING_CAPS[accttype] || 0),
      sourceBackfill: syncResult.sourceBackfill,
      eligibility: syncResult.eligibility || null,
      balances: syncResult.balances || summarizePairingBalances({}),
      pagination: paginated.pagination,
    };
  }

  const normalizedRows = await normalizeLedgerTraceRows(syncResult.rows, syncResult.incomeEventMap, conn);
  const paginated = paginateRows(normalizedRows, page, perPage);

  return {
    rows: paginated.rows,
    allRows: normalizedRows,
    summary: syncResult.summary,
    packageName: ACCOUNT_TYPES[accttype] || 'Unknown',
    weeklyCap: toNumber(PAIRING_CAPS[accttype] || 0),
    sourceBackfill: syncResult.sourceBackfill,
    eligibility: syncResult.eligibility || null,
    balances: syncResult.balances || summarizePairingBalances({}),
    pagination: paginated.pagination,
  };
}

async function normalizeLedgerTraceRows(rows = [], incomeEventMap = null, conn = pool) {
  const sourceMetaMap = await buildPairingSourceMetaMap(
    rows.flatMap((row) => [row.leftSourceMemberUid, row.rightSourceMemberUid]),
    conn
  );

  return [...rows]
    .sort((a, b) => new Date(b.pairedAt) - new Date(a.pairedAt) || String(b.ledgerUid).localeCompare(String(a.ledgerUid)))
    .map((row) => {
      const leftMeta = sourceMetaMap.get(toNumber(row.leftSourceMemberUid)) || {};
      const rightMeta = sourceMetaMap.get(toNumber(row.rightSourceMemberUid)) || {};
      return {
        ledgerUid: row.ledgerUid,
        ownerUid: toNumber(row.ownerUid),
        pairPoints: toNumber(row.pairPoints),
        pairCap: toNumber(row.pairCap),
        pairMonthCap: toNumber(row.pairMonthCap || 0),
        creditedIncome: toNumber(row.creditedIncome),
        grossIncome: toNumber(row.grossIncome),
        blockedIncome: Math.max(0, toNumber(row.grossIncome) - toNumber(row.creditedIncome)),
        flushoutIncome: Math.max(0, toNumber(row.grossIncome) - toNumber(row.creditedIncome)),
        capApplied: Boolean(row.capApplied),
        eligibilityLocked: Boolean(row.eligibilityLocked),
        eligibilityLockedReason: row.eligibilityLockedReason || null,
        pairedAt: row.pairedAt,
        weekKey: row.weekKey || null,
        pairingMonthKey: row.pairingMonthKey || null,
        incomeEventUid: incomeEventMap?.get?.(row.ledgerUid) || null,
        left: {
          eventUid: row.leftEventUid,
          sourceMemberUid: toNumber(row.leftSourceMemberUid),
          username: row.leftUsername || null,
          fullName: row.leftFullName || row.leftUsername || `UID ${row.leftSourceMemberUid}`,
          eventType: row.leftEventType,
          packageType: leftMeta.packageType ?? toNumber(row.leftPackageType),
          packageLabel: leftMeta.packageLabel || packageLabelForType(row.leftPackageType),
          accountStateLabel: leftMeta.accountStateLabel || 'Unknown',
          pointsBefore: toNumber(row.leftPointsBefore),
          remainingAfter: toNumber(row.leftRemainingAfter),
          fullyConsumed: Boolean(row.leftFullyConsumed),
        },
        right: {
          eventUid: row.rightEventUid,
          sourceMemberUid: toNumber(row.rightSourceMemberUid),
          username: row.rightUsername || null,
          fullName: row.rightFullName || row.rightUsername || `UID ${row.rightSourceMemberUid}`,
          eventType: row.rightEventType,
          packageType: rightMeta.packageType ?? toNumber(row.rightPackageType),
          packageLabel: rightMeta.packageLabel || packageLabelForType(row.rightPackageType),
          accountStateLabel: rightMeta.accountStateLabel || 'Unknown',
          pointsBefore: toNumber(row.rightPointsBefore),
          remainingAfter: toNumber(row.rightRemainingAfter),
          fullyConsumed: Boolean(row.rightFullyConsumed),
        },
      };
    });
}

function buildPairingHistoryRows(rows = []) {
  return rows
    .filter((row) => toNumber(row.creditedIncome) > 0)
    .map((row) => ({
      historyUid: row.ledgerUid,
      pairedAt: row.pairedAt,
      matchedPoints: toNumber(row.pairPoints),
      creditedIncome: toNumber(row.creditedIncome),
      left: row.left,
      right: row.right,
      leftRemainingAfter: toNumber(row.left?.remainingAfter),
      rightRemainingAfter: toNumber(row.right?.remainingAfter),
    }));
}

async function getPairingLegAccounts(ownerUid, accttype, side, options = {}, conn = pool) {
  const normalizedSide = side === 'right' ? 'right' : 'left';
  const page = Math.max(1, Number(options.page) || 1);
  const perPage = Math.min(200, Math.max(1, Number(options.perPage) || 50));
  const syncResult = await syncPairingLedger(ownerUid, accttype, conn);
  const events = await loadOwnerBinaryPointEvents(ownerUid, conn);
  const legEvents = events.filter((row) => row.ownerLeg === normalizedSide);
  const ledgerRows = normalizeLedgerTraceRows(syncResult.rows || [], null);

  const [metaRows] = await conn.query(
    `SELECT c.descendant_uid AS uid, c.depth, c.leg,
            u.currentaccttype, u.codeid, u.cdamount, u.cdtotal, u.cdstatus, u.position, u.refid, u.drefid, u.datereg,
            m.username, m.firstname, m.lastname,
            pm.username AS placement_username
       FROM binary_tree_closuretab c
       INNER JOIN usertab u ON u.uid = c.descendant_uid
       LEFT JOIN memberstab m ON m.uid = u.uid
       LEFT JOIN memberstab pm ON pm.uid = u.refid
      WHERE c.ancestor_uid = ?
        AND c.depth > 0
        AND c.leg = ?
      ORDER BY c.depth ASC, u.datereg ASC, c.descendant_uid ASC`,
    [ownerUid, normalizedSide]
  );

  const metaMap = new Map();
  for (const row of metaRows) {
    if (!metaMap.has(Number(row.uid))) {
      metaMap.set(Number(row.uid), row);
    }
  }

  const eventBuckets = new Map();
  for (const event of legEvents) {
    const memberUid = Number(event.sourceMemberUid);
    if (!eventBuckets.has(memberUid)) {
      eventBuckets.set(memberUid, {
        sourceMemberUid: memberUid,
        ownerLeg: normalizedSide,
        totalSourcePoints: 0,
        totalMatchedPoints: 0,
        eventCount: 0,
        events: [],
      });
    }
    const bucket = eventBuckets.get(memberUid);
    bucket.totalSourcePoints += toNumber(event.pointValue);
    bucket.eventCount += 1;
    bucket.events.push({
      eventUid: event.eventUid,
      eventType: event.eventType,
      packageType: event.packageType,
      pointValue: toNumber(event.pointValue),
      eventTs: event.eventTs,
      referenceKey: event.referenceKey || null,
      matchedPoints: 0,
      remainingAfter: toNumber(event.pointValue),
      fullyConsumed: false,
      pairings: [],
    });
  }

  const eventLookup = new Map();
  for (const bucket of eventBuckets.values()) {
    for (const entry of bucket.events) {
      eventLookup.set(entry.eventUid, { bucket, entry });
    }
  }

  for (const row of ledgerRows) {
    const sourceSide = normalizedSide === 'left' ? row.left : row.right;
    const lookup = eventLookup.get(sourceSide?.eventUid);
    if (!lookup) continue;
    lookup.bucket.totalMatchedPoints += toNumber(row.pairPoints);
    lookup.entry.matchedPoints += toNumber(row.pairPoints);
    lookup.entry.remainingAfter = toNumber(sourceSide?.remainingAfter);
    lookup.entry.fullyConsumed = Boolean(sourceSide?.fullyConsumed);
    lookup.entry.pairings.push({
      ledgerUid: row.ledgerUid,
      pairedAt: row.pairedAt,
      matchedPoints: toNumber(row.pairPoints),
      grossIncome: toNumber(row.grossIncome),
      creditedIncome: toNumber(row.creditedIncome),
      blockedIncome: toNumber(row.blockedIncome),
      counterpart: normalizedSide === 'left' ? row.right : row.left,
      remainingAfter: toNumber(sourceSide?.remainingAfter),
    });
  }

  const balances = syncResult.balances || summarizePairingBalances({});
  const strongLeg = balances.availableLeftPoints === balances.availableRightPoints
    ? 'balanced'
    : (balances.availableLeftPoints > balances.availableRightPoints ? 'left' : 'right');

  for (const meta of metaMap.values()) {
    const memberUid = Number(meta.uid || 0);
    if (!eventBuckets.has(memberUid)) {
      eventBuckets.set(memberUid, {
        sourceMemberUid: memberUid,
        ownerLeg: normalizedSide,
        totalSourcePoints: 0,
        totalMatchedPoints: 0,
        eventCount: 0,
        events: [],
      });
    }
  }

  const rows = await Promise.all([...eventBuckets.values()].map(async (bucket) => {
    const meta = metaMap.get(bucket.sourceMemberUid) || {};
    const effectiveRow = await getEffectiveAccountState(bucket.sourceMemberUid, meta, conn);
    const totalSourcePoints = toNumber(bucket.totalSourcePoints);
    const totalMatchedPoints = toNumber(bucket.totalMatchedPoints);
    const remainingPoints = Math.max(0, totalSourcePoints - totalMatchedPoints);
    const eligibleSource = countsForPairingSource(effectiveRow);
    const isDirectReferral = Number(meta.drefid || 0) === Number(ownerUid || 0);
    const unlockQualifiedDirect = isDirectReferral && eligibleSource;

    let pairingStatus = 'Waiting For BP';
    if (!eligibleSource) pairingStatus = 'Not Eligible';
    else if (totalSourcePoints <= 0) pairingStatus = 'No Qualified BP Yet';
    else if (totalMatchedPoints > 0 && remainingPoints > 0) pairingStatus = 'Partially Paired';
    else if (totalMatchedPoints > 0 && remainingPoints <= 0) pairingStatus = 'Fully Paired';
    else if (totalSourcePoints > 0) pairingStatus = 'Not Yet Paired';

    return {
      sourceMemberUid: bucket.sourceMemberUid,
      username: meta.username || bucket.events[0]?.username || `UID ${bucket.sourceMemberUid}`,
      fullName: `${meta.firstname || ''} ${meta.lastname || ''}`.trim() || bucket.events[0]?.fullName || `UID ${bucket.sourceMemberUid}`,
      depth: Number(meta.depth || 0),
      ownerLeg: normalizedSide,
      accttype: Number(effectiveRow?.currentaccttype || meta.currentaccttype || 0),
      packageLabel: packageLabelForType(effectiveRow?.currentaccttype || meta.currentaccttype || 0),
      accountStateLabel: getAccountStateLabel(effectiveRow || meta),
      totalSourcePoints,
      totalMatchedPoints,
      remainingPoints,
      eligibleSource,
      pairingStatus,
      isDirectReferral,
      unlockQualifiedDirect,
      placementUsername: meta.placement_username || null,
      registeredAt: meta.datereg || null,
      eventCount: Number(bucket.eventCount || 0),
      currentLegStrength: strongLeg,
      isStrongLeg: strongLeg === normalizedSide,
      details: bucket.events.sort((a, b) => new Date(a.eventTs) - new Date(b.eventTs) || String(a.eventUid).localeCompare(String(b.eventUid))),
    };
  }));

  rows.sort((a, b) =>
    Number(a.depth || 0) - Number(b.depth || 0)
    || String(a.username || '').localeCompare(String(b.username || ''))
    || Number(a.sourceMemberUid || 0) - Number(b.sourceMemberUid || 0)
  );

  const paginated = paginateRows(rows, page, perPage);
  return {
    side: normalizedSide,
    rows: paginated.rows,
    pagination: paginated.pagination,
    summary: {
      strongLeg,
      totalAccounts: rows.length,
      eligibleAccounts: rows.filter((row) => row.eligibleSource).length,
      fullyPairedAccounts: rows.filter((row) => row.pairingStatus === 'Fully Paired').length,
      partialAccounts: rows.filter((row) => row.pairingStatus === 'Partially Paired').length,
      waitingAccounts: rows.filter((row) => row.pairingStatus === 'Not Yet Paired').length,
      ineligibleAccounts: rows.filter((row) => row.pairingStatus === 'Not Eligible').length,
      totalSourcePoints: rows.reduce((sum, row) => sum + toNumber(row.totalSourcePoints), 0),
      totalMatchedPoints: rows.reduce((sum, row) => sum + toNumber(row.totalMatchedPoints), 0),
      totalRemainingPoints: rows.reduce((sum, row) => sum + toNumber(row.remainingPoints), 0),
    },
  };
}

module.exports = {
  normalizeTrackerEvent,
  buildPairingLedgerEntries,
  summarizePairingBalances,
  summarizePairingTrace,
  buildPairingHistoryRows,
  backfillHistoricalBinaryPointEvents,
  loadOwnerBinaryPointEvents,
  syncPairingLedger,
  getPairingTrace,
  getPairingLegAccounts,
};
