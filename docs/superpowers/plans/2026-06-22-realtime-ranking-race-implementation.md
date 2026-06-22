# Real-Time Ranking Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Maintenance/Unilevel and Hi-Five product-code use atomically update the complete affected ranking race and push member/admin leaderboard changes without browser refresh.

**Architecture:** A MariaDB advisory lock serializes ranking mutation. A targeted work queue evaluates sponsor ancestors deepest-first and cascades through binary/sponsor ancestors after rank changes, writing snapshots, achievements, consumption, incremental aggregates, and an SSE outbox in the product-code transaction. After commit, the existing fork-mode SSE hub publishes authoritative invalidations; clients silently refetch and reorder.

**Tech Stack:** Node.js 20, Express, mysql2, MariaDB 10.11 recursive CTEs/advisory locks, Node test runner, React 18, Vite, browser EventSource/SSE.

---

## File Map

Backend:

- Create `migrations/V037__realtime_ranking_events.sql`: processed-event and realtime-outbox schema.
- Create `services/rankingEventProcessor.js`: affected-work-set orchestration and idempotent transaction-bound processing.
- Create `services/rankingRealtime.js`: SSE outbox publication/recovery poller.
- Modify `services/ranking.js`: permit authoritative single-member evaluation without recursive sponsor-child traversal.
- Modify `services/rankPoints.js`: keep incremental aggregate writes transaction-bound and return affected ancestors.
- Modify `routes/codes.js`: capture repurchase ID, lock/process/commit, publish after commit.
- Modify `routes/events.js`: add safe global member broadcast.
- Modify `services/schemaReadiness.js`: require the new ranking tables.
- Modify `index.js`: start ranking outbox recovery.
- Create `scripts/reconcile_realtime_rankings.js`: read-only drift verification.
- Create `scripts/replay_ranking_events.js`: guarded, idempotent high-water replay.
- Create `tests/unit/rankingEventProcessor.test.js` and `tests/unit/rankingRealtime.test.js`.
- Modify `tests/unit/rankingRace.test.js`, `tests/unit/rankingRepurchaseBasis.test.js`, and `tests/unit/rankingSnapshotFreshness.test.js` to match current approved semantics.

Frontend:

- Rename `src/hooks/useSupportStream.js` to `src/hooks/useRealtimeStream.js` and register ranking events.
- Create `src/utils/realtimeBus.js`: one-process typed subscription bus.
- Create `src/hooks/useRealtimeEvent.js`: React subscription/debounce hook.
- Create `src/utils/realtimeBus.test.js`: pure EventSource/refetch scheduling tests.
- Modify `src/layouts/MemberLayout.jsx` and `src/layouts/AdminLayout.jsx`: keep one SSE connection per authenticated layout.
- Modify `src/pages/member/RankingProgress.jsx`, `src/pages/member/Leaderboard.jsx`, and `src/pages/admin/Rankings.jsx`: authoritative silent refetch on ranking events.

Documentation:

- Create `docs/feature-launches/2026-06-22-realtime-ranking-race.md` in the project documentation root.
- Create/update the exact GREEN and BLUE verification/runbook section in the launch note.

### Task 1: Add idempotent event and outbox schema

**Files:**
- Create: `migrations/V037__realtime_ranking_events.sql`
- Modify: `services/schemaReadiness.js`
- Test: `tests/unit/rankingEventProcessor.test.js`

- [ ] **Step 1: Write the failing schema contract test**

Add a test that reads V037 and asserts the two primary/unique guards and required indexes:

```js
test('V037 guards one ranking process and one outbox event per repurchase', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../migrations/V037__realtime_ranking_events.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranking_event_processstab/i);
  assert.match(sql, /PRIMARY KEY \(repurchase_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ranking_realtime_outboxtab/i);
  assert.match(sql, /UNIQUE KEY uq_ranking_outbox_repurchase \(repurchase_id\)/i);
  assert.match(sql, /KEY idx_ranking_outbox_pending \(status, available_at, id\)/i);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/unit/rankingEventProcessor.test.js`

Expected: FAIL because `V037__realtime_ranking_events.sql` does not exist.

- [ ] **Step 3: Add the migration**

Create both additive tables:

```sql
CREATE TABLE IF NOT EXISTS ranking_event_processstab (
  repurchase_id INT NOT NULL,
  source_member_uid INT NOT NULL,
  points DECIMAL(16,2) NOT NULL,
  process_key VARCHAR(120) NOT NULL,
  status ENUM('processing','completed') NOT NULL DEFAULT 'processing',
  affected_member_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at TIMESTAMP(6) NULL,
  PRIMARY KEY (repurchase_id),
  UNIQUE KEY uq_ranking_event_process_key (process_key),
  KEY idx_ranking_event_source (source_member_uid, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ranking_realtime_outboxtab (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_uid CHAR(36) NOT NULL,
  repurchase_id INT NOT NULL,
  affected_member_uids LONGTEXT NOT NULL,
  status ENUM('pending','published') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  published_at TIMESTAMP(6) NULL,
  last_error VARCHAR(1000) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ranking_outbox_event (event_uid),
  UNIQUE KEY uq_ranking_outbox_repurchase (repurchase_id),
  KEY idx_ranking_outbox_pending (status, available_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Add both tables/columns to `SCHEMA_REQUIREMENTS.RANKING`.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node --test tests/unit/rankingEventProcessor.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/V037__realtime_ranking_events.sql services/schemaReadiness.js tests/unit/rankingEventProcessor.test.js
git commit -m "feat(ranking): add realtime event and outbox schema"
```

### Task 2: Extract transaction-bound single-member evaluation

**Files:**
- Modify: `services/ranking.js:725-907`
- Test: `tests/unit/rankingEventProcessor.test.js`

- [ ] **Step 1: Write the failing evaluator test**

Test the public API contract:

```js
test('rebuildRankSnapshot skips sponsor-child recursion for targeted evaluation', async () => {
  const calls = [];
  const conn = createRankingConnectionFixture({ calls, sponsorChildren: [22, 23] });
  await rebuildRankSnapshot(11, conn, {
    memo: new Map(), stack: new Set(), definitions: fixtures.definitions,
    excludedSet: new Set(), recurseChildren: false,
  });
  assert.equal(calls.some((call) => call.params?.includes(22)), false);
  assert.equal(calls.some((call) => call.params?.includes(23)), false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/unit/rankingEventProcessor.test.js`

Expected: FAIL because current `rebuildRankSnapshot` always traverses sponsor children.

- [ ] **Step 3: Add the targeted option**

Change the traversal block without changing default full-rebuild behavior:

```js
const sponsorChildren = ctx.recurseChildren === false
  ? []
  : await getSponsorChildren(memberUid, conn);

for (const childUid of sponsorChildren) {
  await rebuildRankSnapshot(childUid, conn, ctx);
}
```

Export any small read helpers required by the event processor, but keep award/consumption writes inside `rebuildRankSnapshot`.

- [ ] **Step 4: Verify focused and existing rank tests**

Run:

```bash
node --test tests/unit/rankingEventProcessor.test.js tests/unit/rankingRace.test.js tests/unit/rankingSnapshotFreshness.test.js
```

Expected: targeted test PASS; existing approved ranking tests PASS after correcting outdated labels/source-leg assertions.

- [ ] **Step 5: Commit**

```bash
git add services/ranking.js tests/unit/rankingEventProcessor.test.js tests/unit/rankingRace.test.js tests/unit/rankingSnapshotFreshness.test.js
git commit -m "refactor(ranking): support targeted member evaluation"
```

### Task 3: Implement the targeted fixed-point ranking processor

**Files:**
- Create: `services/rankingEventProcessor.js`
- Modify: `services/rankPoints.js`
- Test: `tests/unit/rankingEventProcessor.test.js`

- [ ] **Step 1: Write failing behavior tests**

Cover the queue and transaction contract:

```js
test('product event evaluates sponsor ancestors nearest-first and excludes purchaser', async () => {
  const evaluated = [];
  const result = await processRepurchaseRankingEvent(fakeConn(), event, {
    getSponsorAncestors: async () => [90, 80, 70],
    evaluateMember: async (uid) => { evaluated.push(uid); return { currentRank: 0 }; },
    getCurrentRank: async () => 0,
    getBinaryAncestors: async () => [],
    applyRepurchaseDelta: async () => {},
    createPublicId: () => 'event-1',
  });
  assert.deepEqual(evaluated, [90, 80, 70]);
  assert.equal(evaluated.includes(event.sourceMemberUid), false);
  assert.deepEqual(result.affectedMemberUids, [90, 80, 70]);
});

test('new rank cascades to binary and sponsor ancestors until stable', async () => {
  const evaluated = [];
  const ranks = new Map([[90, 0], [44, 0], [33, 0]]);
  await processRepurchaseRankingEvent(fakeConn(), event, {
    getSponsorAncestors: async (uid) => uid === event.sourceMemberUid ? [90] : uid === 44 ? [33] : [],
    getBinaryAncestors: async (uid) => uid === 90 ? [44] : [],
    getCurrentRank: async (uid) => ranks.get(uid) || 0,
    evaluateMember: async (uid) => {
      evaluated.push(uid);
      ranks.set(uid, 1);
      return { currentRank: 1 };
    },
    applyRepurchaseDelta: async () => {},
    createPublicId: () => 'event-2',
  });
  assert.deepEqual(evaluated, [90, 44, 33]);
});

test('completed repurchase replay is a no-op', async () => {
  let evaluations = 0;
  const result = await processRepurchaseRankingEvent(completedEventConn(), event, {
    evaluateMember: async () => { evaluations += 1; },
  });
  assert.equal(result.alreadyProcessed, true);
  assert.equal(evaluations, 0);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/unit/rankingEventProcessor.test.js`

Expected: FAIL because the processor is missing.

- [ ] **Step 3: Implement the processor**

Provide these exports:

```js
const RANKING_LOCK_NAME = 'ranking_race_global_v1';
const MAX_RANKING_WORK_ITEMS = 256;

async function acquireRankingLock(conn, timeoutSeconds = 10)
async function releaseRankingLock(conn)
async function getSponsorAncestors(conn, sourceUid)
async function getBinaryAncestors(conn, memberUid)
async function processRepurchaseRankingEvent(conn, event, overrides = {})
```

`acquireRankingLock` must run `SELECT GET_LOCK(?, ?) AS acquired` and reject unless the result is `1`; `releaseRankingLock` must run `SELECT RELEASE_LOCK(?)`. Sponsor ancestry uses a cycle-safe recursive `memberstab.drefid` CTE capped at 30 levels and ordered nearest first. Binary ancestry reads `binary_tree_closuretab`, ordered by descending depth. The processor owns the deterministic fixed-point queue described below.

The fixed-point loop must:

```js
while (queue.length) {
  if (++iterations > MAX_RANKING_WORK_ITEMS) throw rankingError('RANKING_WORK_LIMIT');
  const uid = queue.shift();
  queued.delete(uid);
  const before = await getStoredRank(uid, conn);
  const snapshot = await evaluateMember(uid, conn, { recurseChildren: false });
  affected.add(uid);
  if (snapshot.currentRank > before) {
    enqueueUnique(await getBinaryAncestors(conn, uid));
    enqueueUnique(await getSponsorAncestors(conn, uid));
  }
}
```

Insert the processed marker before work, apply the repurchase delta on the same connection, insert one pending outbox row, and mark processing completed before returning.

- [ ] **Step 4: Verify GREEN and regression tests**

Run:

```bash
node --test tests/unit/rankingEventProcessor.test.js tests/unit/rankingRace.test.js tests/unit/rankingRepurchaseBasis.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add services/rankingEventProcessor.js services/rankPoints.js tests/unit/rankingEventProcessor.test.js tests/unit/rankingRepurchaseBasis.test.js
git commit -m "feat(ranking): process affected race members atomically"
```

### Task 4: Make product-code activation atomic with ranking

**Files:**
- Modify: `routes/codes.js:349-453`
- Test: `tests/unit/rankingEventProcessor.test.js`

- [ ] **Step 1: Write the failing integration contract test**

Assert that positive-point Maintenance and Hi-Five events call the processor before commit, and that processor failure rolls back instead of returning success.

```js
test('maintenance activation commits only after realtime ranking processing', async () => {
  assert.deepEqual(callOrder, ['insert-repurchase', 'process-ranking', 'commit', 'publish']);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/unit/rankingEventProcessor.test.js`

Expected: FAIL because the route commits before asynchronous ranking refresh.

- [ ] **Step 3: Replace the background refresh**

Capture the insert result and execute:

```js
const [repurchaseResult] = await conn.query(repurchaseInsertSql, repurchaseInsertParams);
await acquireRankingLock(conn);
rankingLockHeld = true;
rankingResult = await processRepurchaseRankingEvent(conn, {
  repurchaseId: repurchaseResult.insertId,
  sourceMemberUid: uid,
  points: Number(codeData.unilevelpoints || 0),
  maintenanceBucket,
  transactionType: transType,
});
await conn.commit();
await releaseRankingLock(conn);
rankingLockHeld = false;
await flushRankingOutboxForRepurchase(repurchaseResult.insertId);
```

Remove the post-commit buyer refresh and out-of-transaction shadow update. Release the advisory lock in `finally` on every path.

- [ ] **Step 4: Verify GREEN**

Run the focused test and the backend test suite:

```bash
node --test tests/unit/rankingEventProcessor.test.js
npm test
```

Expected: focused tests PASS; no new failures.

- [ ] **Step 5: Commit**

```bash
git add routes/codes.js tests/unit/rankingEventProcessor.test.js
git commit -m "fix(ranking): process code points before activation commit"
```

### Task 5: Add durable SSE publication

**Files:**
- Create: `services/rankingRealtime.js`
- Modify: `routes/events.js`
- Modify: `index.js`
- Test: `tests/unit/rankingRealtime.test.js`

- [ ] **Step 1: Write failing publication tests**

```js
test('outbox publishes targeted member and global leaderboard invalidations', async () => {
  const calls = [];
  await publishOutboxRow(row, {
    publishToUser: (uid, event) => calls.push([uid, event]),
    publishToAllUsers: (event) => calls.push(['all', event]),
    publishToAdmins: (event) => calls.push(['admins', event]),
  });
  assert.deepEqual(calls, [
    [90, 'ranking.member.updated'],
    [80, 'ranking.member.updated'],
    ['all', 'ranking.leaderboard.updated'],
    ['admins', 'ranking.leaderboard.updated'],
  ]);
});
```

Also assert failed publication keeps the row pending with a bounded retry delay.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/unit/rankingRealtime.test.js`

Expected: FAIL because publisher/global member broadcast is missing.

- [ ] **Step 3: Implement publication and recovery**

Add `publishToAllUsers` to `routes/events.js`. Implement:

```js
async function flushRankingOutboxForRepurchase(repurchaseId)
async function flushPendingRankingOutbox(limit = 20)
function startRankingRealtimeWorker()
```

The flush functions claim pending rows with `SELECT ... FOR UPDATE SKIP LOCKED`, increment `attempts`, publish after the claim transaction commits, and then mark the row `published`; publication failure restores `pending`, records a truncated error, and advances `available_at` by at most 30 seconds. The worker owns one module-scoped, unref'd 1-second interval.

Payloads contain only `eventUid`, `repurchaseId`, affected UID for targeted events, and `committedAt`. Start the worker beside `jobWorker` in `index.js`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test tests/unit/rankingRealtime.test.js
npm test
```

Expected: publication tests PASS; backend regression status recorded.

- [ ] **Step 5: Commit**

```bash
git add services/rankingRealtime.js routes/events.js index.js tests/unit/rankingRealtime.test.js
git commit -m "feat(ranking): publish durable realtime ranking events"
```

### Task 6: Add reconciliation and replay tooling

**Files:**
- Create: `scripts/reconcile_realtime_rankings.js`
- Create: `scripts/replay_ranking_events.js`
- Test: `tests/unit/rankingEventProcessor.test.js`

- [ ] **Step 1: Write failing script safety tests**

Assert both scripts call `loadBackendEnv`, print the selected DB before work, and that reconciliation contains no mutation SQL. Assert replay requires explicit `--from-id` and uses the processed-event guard.

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/unit/rankingEventProcessor.test.js`

Expected: FAIL because scripts are absent.

- [ ] **Step 3: Implement scripts**

Required commands:

```bash
NODE_ENV=production node scripts/reconcile_realtime_rankings.js --limit 100
NODE_ENV=production node scripts/replay_ranking_events.js --from-id 686 --to-id 700
```

Reconciliation reports snapshot/event/aggregate drift and exits nonzero on unexplained mismatches. Replay acquires the ranking advisory lock per event, opens one transaction, calls the idempotent processor, commits, releases, then flushes outbox.

- [ ] **Step 4: Verify GREEN**

Run focused tests and execute reconciliation against the local reference-derived development DB only.

- [ ] **Step 5: Commit**

```bash
git add scripts/reconcile_realtime_rankings.js scripts/replay_ranking_events.js tests/unit/rankingEventProcessor.test.js
git commit -m "feat(ranking): add realtime reconciliation and replay tools"
```

### Task 7: Generalize the frontend realtime stream

**Files:**
- Rename: `src/hooks/useSupportStream.js` to `src/hooks/useRealtimeStream.js`
- Create: `src/utils/realtimeBus.js`
- Create: `src/hooks/useRealtimeEvent.js`
- Create: `src/utils/realtimeBus.test.js`
- Modify: `src/layouts/MemberLayout.jsx`
- Modify: `src/layouts/AdminLayout.jsx`

- [ ] **Step 1: Write failing bus/debounce tests**

```js
test('realtime bus delivers typed events and unsubscribe stops delivery', () => {
  const seen = [];
  const off = subscribeRealtimeEvent('ranking.leaderboard.updated', (data) => seen.push(data));
  emitRealtimeEvent('ranking.leaderboard.updated', { eventUid: 'a' });
  off();
  emitRealtimeEvent('ranking.leaderboard.updated', { eventUid: 'b' });
  assert.deepEqual(seen, [{ eventUid: 'a' }]);
});

test('debounced invalidator collapses a burst into one reload', async () => {
  let reloads = 0;
  const schedule = createDebouncedInvalidator(() => { reloads += 1; }, 20);
  schedule(); schedule(); schedule();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reloads, 1);
  schedule.cancel();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test src/utils/realtimeBus.test.js`

Expected: FAIL because the bus is missing.

- [ ] **Step 3: Implement the bus and generalized stream**

`useRealtimeStream` registers:

```js
const REALTIME_EVENTS = [
  'support.reply', 'support.read', 'support.status',
  'ranking.member.updated', 'ranking.leaderboard.updated',
];
```

Every received event is emitted to the bus and optionally passed to the layout callback. `useRealtimeEvent` holds the latest callback in a ref and debounces refreshes without recreating EventSource connections. Update both layouts to the renamed hook.

- [ ] **Step 4: Verify GREEN and build**

Run:

```bash
node --test src/utils/realtimeBus.test.js
npm run build
```

Expected: tests PASS; Vite production build succeeds.

- [ ] **Step 5: Commit in frontend repository**

```bash
git add src/hooks src/utils/realtimeBus.js src/utils/realtimeBus.test.js src/layouts/MemberLayout.jsx src/layouts/AdminLayout.jsx
git commit -m "feat(realtime): generalize authenticated event stream"
```

### Task 8: Make ranking pages refetch and reorder live

**Files:**
- Modify: `src/pages/member/RankingProgress.jsx`
- Modify: `src/pages/member/Leaderboard.jsx`
- Modify: `src/pages/admin/Rankings.jsx`
- Test: `src/utils/realtimeBus.test.js`

- [ ] **Step 1: Write failing refresh-policy tests**

Define and test pure event filters:

```js
assert.equal(shouldRefreshMemberRanking({ memberUid: 90 }, 90), true);
assert.equal(shouldRefreshMemberRanking({ memberUid: 80 }, 90), false);
assert.equal(shouldRefreshLeaderboard('ranking.leaderboard.updated'), true);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test src/utils/realtimeBus.test.js`

Expected: FAIL because refresh policies are absent.

- [ ] **Step 3: Subscribe pages**

Member progress subscribes to `ranking.member.updated` and calls its existing authoritative `loadData` only when the UID matches. Member/admin leaderboard pages subscribe to `ranking.leaderboard.updated`, retain current data during refresh, and reload their active page. Use a 150 ms debounce and replace warm-cache values after success.

- [ ] **Step 4: Verify GREEN and build**

Run:

```bash
node --test src/utils/realtimeBus.test.js
npm run build
npm run doctor:guard
```

Expected: test/build/guard PASS, with no new high-confidence React findings.

- [ ] **Step 5: Commit in frontend repository**

```bash
git add src/pages/member/RankingProgress.jsx src/pages/member/Leaderboard.jsx src/pages/admin/Rankings.jsx src/utils/realtimeBus.js src/utils/realtimeBus.test.js
git commit -m "feat(ranking): update progress and leaderboards live"
```

### Task 9: Verify, document, and prepare GREEN-to-BLUE execution guide

**Files:**
- Create: `../docs/feature-launches/2026-06-22-realtime-ranking-race.md`
- Modify: plan checkboxes as completed evidence is collected

- [ ] **Step 1: Run backend verification**

```bash
node --test tests/unit/rankingEventProcessor.test.js tests/unit/rankingRealtime.test.js tests/unit/rankingRace.test.js tests/unit/rankingRepurchaseBasis.test.js tests/unit/rankingSnapshotFreshness.test.js
npm test
```

Record pre-existing failures separately; no new failure may be introduced.

- [ ] **Step 2: Run frontend verification**

```bash
node --test src/utils/realtimeBus.test.js
npm run build
npm run doctor:guard
```

- [ ] **Step 3: GREEN deployment rehearsal**

```bash
cd /var/www/nogatu-green
git pull origin staging
npm ci --omit=dev
npm run db:migrate
pm2 restart nogatu-mlm-green --update-env
```

Verify the printed DB is staging, run reconciliation, use one Unilevel and one Hi-Five code, and observe two authenticated browsers update without refresh.

- [ ] **Step 4: BLUE step-by-step guide**

The launch note must include:

```bash
cd /var/www/nogatu
NODE_ENV=production node scripts/backupCurrentDb.js
NODE_ENV=production node scripts/replay_ranking_events.js --print-high-water
git pull origin master
npm ci --omit=dev
NODE_ENV=production npm run db:migrate:prod
NODE_ENV=production node scripts/rebuild_rankings.js
NODE_ENV=production node scripts/backfill_rank_points.js
NODE_ENV=production node scripts/reconcile_realtime_rankings.js --limit 200
NODE_ENV=production node scripts/replay_ranking_events.js --from-id "$((RANKING_HIGH_WATER + 1))"
pm2 restart nogatu-mlm --update-env
pm2 save
```

Before the sequence, set `RANKING_HIGH_WATER` to the integer printed by `--print-high-water`. Every database-aware script must print the loaded env path and database name and abort unless production resolves to `.env.prod` and `nogatualliance_sysdb`; keep BLUE in fork mode.

- [ ] **Step 5: Write the feature-launch note**

Document scope, files, V037, no new environment variables, test results, GREEN evidence, BLUE commands, reconciliation output, monitoring, and rollback.

- [ ] **Step 6: Final commit(s)**

Commit the backend launch evidence without staging unrelated wallet/encashment changes. Commit frontend evidence only if frontend files changed. Do not push or deploy until explicitly authorized.

---

## Completion Gate

- Every new behavior has a test that was observed failing first.
- Product-code success is impossible before ranking transaction success.
- Sponsor points, binary structural cascade, consumption, achievements, and snapshots reconcile.
- SSE publishes after commit and recovers pending outbox rows.
- Personal progress and member/admin leaderboards update without browser refresh.
- GREEN rehearsal passes before any BLUE command.
- The final feature-launch note contains the exact step-by-step operator guide.
