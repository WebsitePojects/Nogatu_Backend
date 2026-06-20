# Commission Traceability + Verification Epic — 2026-06-20

Delivers admin/member traceability + verification for every commission, the revised
unilevel tree, and the simplified ranking summary. All grounded in existing
authoritative ledgers (no fabricated rows; money-integrity rule held throughout).

## Shipped

| Ask | What shipped | Commits |
|-----|--------------|---------|
| #10 Ranking summary = remaining + rank; live per-event basis table | RankingProgress → 2 cards (Remaining + Rank); `GET /api/ranking/events` paginated; "Rankable Points Ledger" under the leaderboard | be 8190a92 · fe 19eac0a |
| #5 Revise unilevel tree (limited levels, click=root, scoped search) | Re-root drill: one level at a time, click a member = new root, breadcrumb back, search jumps into a bloodline | fe 48e77f4 |
| #7/#9 Commission transparency — all 6 income types traceable | Transaction detail now resolves real sources for **unilevel** (downline product points), **leadership** (1–5 level downline pairing × 5/2/1/1/1%), **ranking** (consumed repurchase events) — the 3 previously-empty blocks | be 7a2c473, 0d11b31 · fe 352e230, d1e5e38 |
| Admin verify L/R → SMB / matched PV | `GET /api/admin/genealogy/pairing-reconcile`; panel in Account Genealogy: Left PV, Right PV, Matched PV (snapshot), Lifetime SMB (paid) side by side | be a630628 · fe 9c0fbeb |
| Admin unilevel level-by-level ledger | Already shipped earlier (admin `/unilevel/points-history` + AdminUnilevelTree panel) | (prior) |

Reuse, not rebuild: pairing/DR/Hi-Five trace, `rankingTransparency`, `getUnilevelProductPointContributors`, `getLeadershipTraceability`, `getPairingCounts`, `listRankableEventsForMember` already existed.

## Money-integrity note (admin must understand)
Matched PV is a **current snapshot**; Lifetime SMB (`payouttotaltab.ttlincome2`) is the
**authoritative already-paid cumulative**. They are different quantities and are NOT
expected to be equal. The reconcile panel shows both separately and never forces them.

## T10 — additional issues spotted (read-only findings; no risky change made)

1. **Unilevel almost never credited (HIGH).** Staging audit: **1 unilevel earner / 7,199**.
   Likely the monthly settlement (`settle_unilevel_month.js`) is not scheduled/run on prod.
   If so, members are not receiving unilevel income — real unpaid money. **ACTION: confirm
   the monthly unilevel cron is scheduled on blue; if not, schedule it.** Re-run
   `audit_commissions.js` on prod to confirm.

2. **Upgraded members over-contribute binary vs a direct same-package member.** Effective
   binary = base + full upgrade-code points (e.g. Bronze→Gold = 250 + 1000 = 1,250 vs a
   direct Gold's 1,000). Matches the confirmed 2026-04-29 "fresh upstream event" rule, so
   the engine is correct — but it IS extra upline pay. **Management: confirm intended.**

3. **Global rank cap (`rankingRace.js:17` MAX_AWARDABLE_RANK = 1)** holds everyone at
   Supervisor 1 pending the binary-leg-vs-unilevel rule. Likely the real "ranking not
   working" cause. **Management decision needed before lifting.**

4. **payouttotaltab coverage 1,626 / 7,199 (staging).** ~77% of members have no payout row
   — they simply have not earned yet. Not a bug, but it explains much of the "commissions
   missing" perception; the new per-type trace makes a member's actual earned/eligible
   sources explicit.

5. **DR flag: 100+ members with direct referrals but ₱0 direct-referral income.** Needs a
   prod per-account spot-check — direct-referral bonus is earned only when the referral
   activated with a qualifying (PD) code, so FS/CD directs legitimately pay the sponsor ₱0.
   Confirm a sample with the transaction trace before treating any as a gap.

6. **Ranking bonus (ttlincome6) = 0 earners** — consistent with admin-fulfillment-only
   design (not auto-credited). Confirm intended.

7. **`nogatumain` (uid=1) has 0 binary points** — company root, no upline; benign.

8. **React Doctor advisory** ("staged regressions") fires on every frontend commit — a
   pre-existing select-label a11y pattern, non-blocking. Worth a dedicated cleanup pass.

## Test (staging)
- Backend (green): `cd /var/www/nogatu-green && git pull origin staging && pm2 restart nogatu-mlm-green --update-env`
- Frontend: push `master` → open Vercel Preview.
- Check: Ranking page (2 cards) + Leaderboard ledger; Unilevel drill (click/breadcrumb/search);
  open income transactions with unilevel/leadership/ranking → contributors listed; admin
  Account Genealogy → Pairing Reconciliation panel.
