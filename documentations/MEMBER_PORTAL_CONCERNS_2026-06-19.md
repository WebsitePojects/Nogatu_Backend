# Member Portal Concerns — Triage, Fixes & Management Decisions (2026-06-19)

Management raised 11 concerns about the new Node/React portal. This logs what was
fixed, what is intended-by-design, and what needs a management decision. Code is
grounded in file references; money/comp-plan rules were NOT changed without sign-off.

## Status table

| # | Concern | Verdict | Action taken |
|---|---------|---------|--------------|
| 1 | Dashboard needs total PV (L/R) from start | Display gap | FIXED — dashboard headline now shows cumulative **Total PV** per leg, unmatched PV as subtext (`Dashboard.jsx`; data already in payload: `leftPoints`/`rightPoints`). |
| 2 | E-wallet unilevel = monthly, released 5th | Missing label | FIXED — Uni-Level row notes "Monthly · released every 5th of next month" (`EWallet.jsx`). |
| 3a | Genealogy names invisible on Android | Real bug | FIXED — LOD shell drew skeleton bars instead of the name below 0.55 zoom; big trees auto-fit under that on Android → names gone. Name now always rendered (`genealogyTreeUi.jsx`). |
| 3b | Tree should show "perfect 15", click to go deeper | UX | FIXED — tree defaults to root + 3 levels (15 nodes); "+N below" loads one level per click (`GenealogyTree.jsx`, `AdminGenealogy.jsx`). |
| 3c | Hide PD/CD/FS tree stats | UX | FIXED — stat chips removed (member + admin genealogy). |
| 4 | Lifetime income ceiling on Bronze/Silver only | **Intended — HOLD** | NO change. See "Management decisions" below. |
| 5 | Unilevel tree hard to read; want list per level | UX | FIXED (member) — added per-level **List view** (default) + Tree toggle (`UnilevelTree.jsx`). Admin mirror pending. |
| 6 | Binary points missing | Audit | Read-only `scripts/audit_binary_points.js` — report before any change. |
| 7 | Commissions missing | Audit | Read-only `scripts/audit_commissions.js` — report before any change. |
| 8 | Ranking locked until Gold | **Intended — kept** | Lock kept (config). Wording fixed: "Ranking unlocks at Gold" instead of misleading "reached its ranking ceiling" (`RankingProgress.jsx`). |
| 9 | Unilevel inconsistent | Audit | Covered by `audit_commissions.js` FLAG 3 (downline but 0 unilevel). Rates/gate verified consistent in code. |
| 10 | Ranking points summary should be visible | Already present | Visible on RankingProgress + Leaderboard (Gross/Consumed/Remaining/Pending), including for locked members. |
| 11 | Others | Open | Awaiting enumeration. |

## Management decisions required (no code change made)

1. **Bronze/Silver lifetime income ceiling (#4).** Intended config — Bronze ₱40,000,
   Silver ₱80,000; Gold+ have NO lifetime ceiling and use weekly/monthly sales-match
   caps instead (`services/packagePolicy.js:13,33,53`). HOLD per management. Decide:
   keep as-is, or change. Any change is money-sensitive and needs reconciliation.

2. **Ranking lock until Gold (#8).** Intended — Bronze/Silver `rankingEligible:false`,
   "Gold opens ranking" (`packagePolicy.js:17,37,57`). Kept; only the wording was
   clarified. Decide if Bronze/Silver should ever rank (comp-plan change).

3. **GLOBAL RANK CAP — everyone stuck at Supervisor 1.** `services/rankingRace.js:17`
   `MAX_AWARDABLE_RANK = 1` is a TEMPORARY lock (set 2026-06-16) holding ALL members
   at rank 1 until the binary-leg-vs-unilevel "leg rule" is decided. This likely
   drives "ranking not working" reports. **Needs the leg-rule decision before the cap
   is raised** — do not lift unilaterally (rank/money-sensitive).

## Read-only audits — how to run (no writes, safe on prod)

On the blue (prod) server, fetch just the two scripts and run them read-only:
```
cd /var/www/nogatu
git fetch origin
git checkout origin/staging -- scripts/audit_binary_points.js scripts/audit_commissions.js
NODE_ENV=production node scripts/audit_binary_points.js
NODE_ENV=production node scripts/audit_commissions.js
```
Both print `env=/db=` first and only SELECT. They flag structural candidates
(paid accounts with 0 binary points; binary points frozen vs current package;
downline-but-zero income). Confirm any flagged member with a per-account trace
(`scripts/diag_pairing.js <username>`) before considering a money correction.

## Shipping
- Phase 1 (encoding-blockers #3a/#3b/#3c): frontend `prod-hotfix-genealogy`
  (= clean prod + payout + genealogy). Pin Vercel there.
- Phase 2 (#1/#2/#5/#8 wording): frontend `master`.
- Phase 3 (audits): backend `staging`, run read-only on prod.
