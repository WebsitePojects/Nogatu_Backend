# Management Concerns — Full Checklist (as of 2026-06-20)

Status of every concern raised, what shipped, where it lives, and what still needs a
decision or a deploy. Money rules held throughout (no guess-fixes; audits read-only).

Legend: ✅ done · 🟡 done, needs deploy to prod · 🔵 intended / documented · ⏳ needs management · 🔬 audited

## Round 1 — the 11 concerns

| # | Concern | Status | What was done | Where |
|---|---------|--------|---------------|-------|
| 1 | Dashboard total PV (L/R) from start | ✅ | Headline now **Total PV** per leg + unmatched PV subtext (data already in payload) | master `4ca33bc` |
| 2 | E-wallet unilevel = monthly, released 5th | ✅ | Note on Uni-Level row | master `9d4459b` |
| 3a | Mobile/Android: no ghost nodes, nodes always populated | 🟡 | Removed LOD ghost shells — every node renders as a full card | master `699de7b` (+`4541d26`); **not yet on prod** |
| 3b | Binary tree = "perfect 15", click to go deeper | 🟡 | `expandAll:false, initialDepth:3`; "+N below" loads one level | master `4541d26`; not yet on prod |
| 3c | Hide PD/CD/FS tree stats | 🟡 | Removed stat chips (member + admin) | master `4541d26`; not yet on prod |
| 4 | Lifetime ceiling on Bronze/Silver only | 🔵⏳ | Intended config (Bronze 40k/Silver 80k; Gold+ none). HOLD — management decides keep vs change | documented |
| 5 | Unilevel tree hard to read | ✅ | Revised to **re-root drill**: one level, click = new root, breadcrumb back, search jumps into a bloodline | master `48e77f4` |
| 6 | Binary points missing | 🔬 | Audited prod: **7,157 match, 0 under-credit**, 39 "over" = upgraded members (base+upgrade) per the confirmed 2026-04-29 rule. NOT a bug | audit_binary_points.js |
| 7 | Commissions missing | ✅ | All 6 income types now traceable in transaction detail (see Round 2); audits ran on prod | staging + master |
| 8 | Ranking locked until Gold | 🔵 | Intended (Gold opens ranking) — kept; misleading "ceiling" copy fixed to "unlocks at Gold" | master `9d4459b` |
| 9 | Unilevel inconsistent | 🔬⏳ | Audited: rates/gate consistent. Root cause = unilevel **never turned on** (new feature) — see Ops | audit_commissions.js |
| 10 | Ranking points summary should show | ✅ | Summary simplified to **Remaining + Rank**; **live Rankable Points Ledger** (paginated) under leaderboard | be `8190a92` · fe `19eac0a` |
| 11 | Others | 🔬 | Spotted — see T10 findings | TRACEABILITY_EPIC doc |

## Round 2 — traceability / admin-verify epic

| Item | Status | Where |
|------|--------|-------|
| Ranking rankable-events endpoint (paginated basis points per valid event) | ✅ | be `8190a92` |
| Ranking summary (remaining+rank) + live ledger under leaderboard | ✅ | fe `19eac0a` |
| Unilevel re-root drill (limited levels, click=root, scoped search) | ✅ | fe `48e77f4` |
| Transaction trace — **unilevel** sources (real downline product points) | ✅ | be `7a2c473` · fe `352e230` |
| Transaction trace — **leadership + ranking** sources (last 2 empty blocks) | ✅ | be `0d11b31` · fe `d1e5e38` |
| Admin **pairing reconciliation** (Left/Right PV → matched PV vs lifetime SMB) | ✅ | be `a630628` · fe `9c0fbeb` |
| Admin unilevel level-by-level ledger (points-history) | ✅ | shipped earlier |

All 6 commission types now show real, grounded sources in transaction detail
(direct-referral, pairing, hi-five already existed; unilevel, leadership, ranking added).
Reused existing services — no fabricated rows.

## Audits run on PROD (read-only)
- **Binary points:** 7,157 match · 0 under-credit · 39 over (intended upgrade rule) · 1 zero (company root). #6 cleared.
- **Commissions:** earners — DR 1199, pairing 1245, leadership 534, unilevel **1**, hi-five 322, ranking 0.
- **Unilevel = 1 earner / 7,204** → confirmed a NEW feature never activated (old DB also had only the 1 test ₱77; old PHP never had unilevel). No back-pay owed, no migration loss.

## Where everything lives (deploys)
- **PROD backend (blue):** payout fix, Bronze SMB full-depth fix, voucher + view-as (other session). NOT yet: epic trace endpoints, unilevel machinery (V034–036).
- **PROD frontend (Vercel = `fe-hotfix-voucher-viewas`):** payout + voucher + view-as. **Missing the genealogy fixes (3a/3b/3c).**
- **STAGING backend (`staging`, green):** full epic + audits + unilevel settlement + maintenance bucket.
- **master (frontend):** everything (epic + genealogy + payout).
- **`prod-hotfix-genealogy`:** clean prod + payout + genealogy (pushed).

## ⏳ Pending management decisions (one batch)
1. **Unilevel go-live** — new feature, ~5/7,199 qualify (200-pt monthly gate). First-ever payout = new money. Approve to enable monthly settlement.
2. **`MAX_AWARDABLE_RANK = 1`** (`rankingRace.js:17`) — everyone capped at Supervisor 1 pending the binary-leg-vs-unilevel rule. Likely the "ranking not working" cause.
3. **Bronze/Silver lifetime ceiling** — keep or change.
4. **Upgraded binary = base + full upgrade event** (e.g. 1,250 vs 1,000) — correct per the 2026-04-29 rule but extra upline pay. Confirm keep.

## 🛠 Pending ops
1. **Genealogy fix → prod:** cherry-pick `4541d26` then `699de7b` onto `fe-hotfix-voucher-viewas`, push → Vercel rebuild. Gives prod the no-ghost-nodes + perfect-15 + no-stats. (Run from one session only — branch shared with the other session.)
2. **Prod backend promote** (parked PROD-OPS): migrate V034–036 on blue + deploy staging backend (trace endpoints + unilevel) in a window; rebuild/reconcile.
3. **Unilevel enable:** after promote + sign-off, schedule monthly cron (`settle_unilevel_month.js`, prev-month, released 5th); dry-run first.
