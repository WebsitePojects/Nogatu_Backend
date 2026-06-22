# Real-Time Ranking Race and Leaderboard Design

Date: 2026-06-22  
Status: Approved direction; awaiting written-spec review

## Objective

When any member uses an eligible product code as Maintenance/Unilevel or Hi-Five, every affected upline's ranking points, rank qualification, consumption records, and leaderboard position must update without a browser refresh. The behavior must preserve the approved sponsor-tree point basis, bottom-up race order, global point consumption, binary rank-structure requirements, and manual incentive fulfillment.

## Confirmed BLUE Context

- BLUE backend: `/var/www/nogatu`, PM2 process `nogatu-mlm`, fork mode, Node 20.
- Production database: MariaDB 10.11, `.env.prod`, database `nogatualliance_sysdb`.
- Relevant migrations V005, V0085, V009, V023, V032, V033, V034, and V036 are applied.
- Current ranking tables exist, including `rankingstab`, achievement/consumption tables, and `member_rank_pointstab`.
- Production evidence showed 42 recent product events, 411 stale event/upline snapshot links, and 15 affected uplines.
- The current route refreshes the purchasing UID. Because ranking excludes the purchaser's own event and awards points to sponsor ancestors, that refresh targets the wrong member.
- The existing authenticated SSE hub is available and BLUE runs one fork-mode process, so in-process publication is valid for the current deployment topology.
- `member_rank_pointstab` is incomplete (132 rows versus about 7,003 ranking snapshots) and cannot be promoted directly without a reconciliation/backfill gate.

## Business Rules Preserved

1. Both Maintenance/Unilevel and Hi-Five product-code uses contribute their positive `incentivepoints1` values to ranking.
2. A member's own repurchase does not contribute to their own ranking points.
3. Points roll upward through the sponsor tree (`drefid`), not binary placement (`refid`).
4. The rank race is bottom-up: the deepest affected eligible member is evaluated first.
5. A new rank may require qualified ranked members in both binary legs.
6. Rank consumption is global. Consumed source points cannot be reused by ancestors.
7. Rank advancement and pending incentive status become immediate.
8. Cash incentive fulfillment remains the approved guarded manual admin action.
9. Flagged/excluded accounts do not rank or consume points.

## Considered Approaches

### Selected: Targeted transactional race with real-time invalidation

Process only the sponsor and binary ancestors whose point or structural state can change. Serialize race mutation with a MariaDB advisory lock, update all ranking ledgers atomically, then publish SSE invalidations after commit.

This preserves correctness while avoiding a full-network rebuild for every product use.

### Rejected: Full ranking-forest rebuild per product event

This can reuse the existing recursive engine but would repeatedly traverse roughly 7,003 accounts and execute many per-member queries. It is unsuitable for request-time worldwide activity.

### Rejected: Immediately make the shadow aggregate authoritative

The shadow table is incomplete and its consumption semantics do not fully replace the rank achievement/race engine. It can remain a reconciliation and optimized aggregate layer until parity is proven.

## Backend Architecture

### 1. Eligible product event

The maintenance-code route validates and locks the code, inserts the `repurchasetab` row, captures its `insertId`, and invokes the ranking event processor on the same database connection before commit.

The input contract is:

- `repurchaseId`
- `sourceMemberUid`
- `points`
- `maintenanceBucket` (`unilevel` or `hifive`)
- `transactionType`
- event timestamp/process key

Zero-point events do not enter the ranking race.

### 2. Race serialization and idempotency

The processor obtains a MariaDB advisory lock such as `ranking_race_global_v1`. The expected event volume is low enough that a global rank lock is the safest initial serialization boundary. This prevents concurrent product uses from consuming the same points or producing duplicate race winners.

A new processed-event table records one row per `repurchase_id` with a unique key, status, timestamps, and failure metadata. Reprocessing an already completed event is a no-op. The event marker is committed in the same transaction as all rank changes.

### 3. Affected-member work set

The initial work set contains the source member's sponsor ancestors up to the existing depth cap of 30. Members are evaluated deepest-first.

If an evaluated member advances in rank, binary ancestors that may now satisfy a left/right structural requirement are added to the work set. If rank consumption changes available points for sponsor ancestors of consumed source events, those ancestors are also added. Processing continues until the work set reaches a fixed point with no additional state changes.

Cycle detection, a unique UID work set, and a bounded iteration limit protect malformed genealogy data.

### 4. Single-member authoritative evaluation

The current rebuild function will be separated into:

- sponsor-child traversal/orchestration; and
- a single-member authoritative evaluator that does not recursively rebuild unaffected descendants.

The evaluator reads the same authoritative sources used today:

- `repurchasetab`
- `rank_global_consumptiontab`
- `rank_point_consumptiontab`
- `rank_achievementstab`
- `rank_definitionstab`
- `binary_tree_closuretab`
- rank exclusions

It computes awards, writes exact consumption rows, updates the incremental point aggregate, and upserts `rankingstab`. Existing unique keys remain the final duplicate-award defense.

### 5. Atomicity

Code consumption, repurchase insertion, processed-event marker, rank achievements, global consumption, transparency consumption, incremental aggregates, and snapshots commit together.

If any ranking step fails, the transaction rolls back. The product code remains unused and the API returns an actionable failure instead of reporting success with stale rankings.

The advisory lock is always released in `finally` after commit or rollback.

## Real-Time Event Delivery

### Event contracts

After a successful commit, the backend publishes:

- `ranking.member.updated` to each affected member, containing only an event/revision identifier, member UID, and committed timestamp.
- `ranking.leaderboard.updated` to connected members and admins, containing an event/revision identifier and committed timestamp.

Clients always refetch authoritative APIs; they never calculate rank or money from SSE payloads.

### Durable outbox

The transaction inserts real-time notification rows into a ranking outbox table. The request path publishes immediately after commit and marks delivery. A lightweight recovery poll republishes pending rows after process failure or restart.

Outbox publication is idempotent by event/revision ID. Duplicate invalidations are harmless because clients refetch authoritative state.

### Deployment topology

The current in-process SSE hub is supported because BLUE runs PM2 fork mode with one worker. If BLUE later moves to cluster/multiple instances, publication must first gain a shared Redis or database-backed pub/sub adapter. The application must not silently enter cluster mode with in-memory-only realtime events.

## Frontend Architecture

The current support-only SSE hook becomes a general authenticated realtime stream with one connection per logged-in layout. A realtime context distributes typed events to pages without opening duplicate EventSource connections.

Behavior by page:

- Member Ranking Progress: refetch `/api/ranking` when `ranking.member.updated` targets the logged-in UID.
- Member leaderboard: refetch its active ranking page on `ranking.leaderboard.updated`.
- Admin Rankings: refetch its active page on `ranking.leaderboard.updated`.
- Ranking event/details tables: invalidate and refetch when the current member is affected.

Refetches are debounced over a short window so a multi-rank cascade causes one visible update. Stale requests are cancelled or ignored. Existing warm-cache entries are replaced with the committed response.

The page remains interactive during background refetch and shows existing data until the new response arrives. SSE reconnect uses the existing retry behavior.

## Error Handling and Observability

- Structured logs include repurchase ID, source UID, affected UID count, awards, consumption totals, elapsed time, and outbox status.
- Lock timeout, cycle detection, iteration-limit, invariant, and SQL errors use distinct error codes.
- Invariants include no negative remaining points, no consumption beyond source-event points, one member/rank award, and gross/consumed/remaining reconciliation.
- Metrics expose processing latency, lock wait, affected-member count, retry count, pending outbox rows, and failures.
- A read-only reconciliation script compares authoritative event totals, snapshots, achievements, and incremental aggregates.

## Existing Drift Recovery

Before live event processing is enabled on BLUE:

1. Back up the production database.
2. Apply additive migrations.
3. Run the full authoritative ranking rebuild off-peak.
4. Backfill `member_rank_pointstab` for all eligible members.
5. Reconcile engine and aggregate values; resolve every unexplained mismatch.
6. Record a high-water repurchase ID.
7. Process any events created after that high-water mark through the idempotent event processor.
8. Enable realtime publication only after reconciliation passes.

This closes the race between the rebuild and continued worldwide product usage.

## Test Strategy

Tests are written first and observed failing before implementation.

Backend coverage:

- Maintenance/Unilevel and Hi-Five contribute identical ranking points.
- Purchaser self-exclusion.
- Multi-level sponsor propagation.
- Bottom-up winner ordering.
- Exact threshold advancement and multi-rank advancement.
- Binary left/right rank cascade.
- Global zero-out and ancestor balance reduction.
- Excluded-account behavior.
- Concurrent events serialize without duplicate awards or over-consumption.
- Transaction rollback leaves the product code unused.
- Idempotent event replay.
- SSE occurs after commit only.
- Outbox recovery after simulated publish failure.

Frontend coverage:

- Personal progress updates after a targeted event without navigation/reload.
- Member and admin leaderboards refetch and reorder after a global event.
- Burst events produce one debounced refetch.
- Reconnect and duplicate event handling.

Staging verification uses a controlled product code and known sponsor/binary chain, confirms database ledgers, observes live updates in two authenticated browsers, and verifies no manual page refresh is needed.

## Rollout and Runbook

1. Preserve unrelated local changes and implement on the staging branches.
2. Add migrations, backend processor/outbox/SSE changes, and frontend realtime context.
3. Run focused tests, full backend/frontend test suites, lint/build, and reconciliation dry runs.
4. Deploy to GREEN and migrate the staging database.
5. Backfill/rebuild GREEN, then execute concurrent Maintenance and Hi-Five smoke cases.
6. Verify member progress, member leaderboard, and admin leaderboard update live.
7. Prepare BLUE database backup and record the current repurchase high-water ID.
8. Deploy additive migrations and backend/frontend code to BLUE using the documented zero-downtime sequence.
9. Rebuild and reconcile historical ranking state off-peak.
10. Replay events above the high-water mark idempotently.
11. Restart BLUE only with `pm2 restart nogatu-mlm --update-env`; keep fork mode.
12. Verify SSE, rank advancement, consumption, leaderboard ordering, PM2 stability, and outbox depth.
13. Monitor processing latency and failures closely after release.
14. Roll back application traffic/code if necessary; keep additive migrations and use idempotent replay after correction.

Every material launch or resolved issue receives a note under `docs/feature-launches/` with scope, files, schema/env changes, and verification evidence.

## Acceptance Criteria

- An eligible Maintenance/Unilevel or Hi-Five product use updates every affected ranking state before the API reports success.
- Correct members advance immediately in approved bottom-up race order.
- Points are consumed once and never reused by ancestors.
- Member progress and both leaderboard views change without browser refresh.
- Concurrent worldwide code uses cannot create duplicate awards or point over-consumption.
- A missed SSE publication is recovered from the outbox.
- Full reconciliation reports no unexplained snapshot or aggregate drift.
- Rank cash remains pending manual fulfillment until an authorized admin releases it.
