# Handoff: NogatuMLM (Nogatu Alliance member portal + income engine)

Last updated: 2026-11-28, on the desktop PC. Handoff moved into git (this file) before the project moves to a laptop.
Still nothing of the 2026-11-26 work is deployed (green/blue/Vercel unchanged since then).
Read this file first in any new session, on any device. Refresh it with `/handoff update`.

Lives in Nogatu_Backend `docs/HANDOFF.md` on `master` (docs only; blue only changes when pulled by hand). The workspace
folder around the repos is NOT a git repo: its `.claude/` rules, `outputs/`, `reports/` travel in the `/migrate` archive.
It never holds secrets, passwords, member data, email addresses or personal names (roles only).

---

## 0. New device setup

### 0.1 Tools
Full list and commands: `.claude/DEPLOY.md` section 1. Required: Git, Node 24 + npm, Python 3.12 (`py -3`) with
`openpyxl` and `pyzipper`, GitHub CLI (`gh auth login`), Docker Desktop (local MariaDB 10.11 test stack).

### 0.2 Get the code
The workspace root is a plain folder (`C:\Users\Win10\Desktop\NogatuMLM` on the desktop). Inside it, side by side:
```
git clone https://github.com/WebsitePojects/Nogatu_Backend.git
git clone https://github.com/WebsitePojects/Nogatu_Frontend.git
```
Feature work happens in git worktrees under `~/.config/superpowers/worktrees/Nogatu_Backend/<name>` and
`.../Nogatu_Frontend/<name>` (the main checkouts are parked on an old staging branch with uncommitted WIP; do not
reset them). Recreate the worktrees you need from the branches in section 5.

### 0.3 Prove it works
Backend (any worktree with `node_modules`): `node --test "tests/unit/*.test.js"` -> 1 known failure only
(`encashment admin UI requires an explicit confirmation...`, it reads a sibling Frontend path).
Green branch `00f824d`: 589 tests / 588 pass. Blue candidate `6f4b7f0`: 456 / 455.
Frontend: `npm run build` -> "built in ~20s"; guard `node scripts/react-doctor-guard.mjs` -> 55 findings (baseline).

### 0.4 Not in git (bring separately)
| Item | Where on the source device | How it travels |
|---|---|---|
| Project memory + rules (auto-loaded) | `<workspace>/.claude/`, `<workspace>/.codex/`, `CLAUDE.md`, `AGENTS.md` | migrate archive |
| Scripts, reports, deploy scripts | `<workspace>/outputs/`, `<workspace>/reports/`, `documentations/` | migrate archive |
| VPS notes (deploy flow, no passwords) | `~/Desktop/VPS/` | migrate archive (home include) |
| Backend local env files | `Nogatu_Backend/.env.development` and in each worktree | migrate archive (secret class) |
| Claude personal memory | `~/.claude/projects/c--Users-Win10-Desktop-NogatuMLM/memory` | migrate archive |
| Production DB password | only on the VPS: `/root/.nogatu-db.cnf` | never copied; owner knows it |
| Prod DB dumps, legacy PHP code + dumps | `prod_db_exports/`, `reference_system/`, `migration/`, `*.sql` in root | real member data: IN the 2026-11-26 archive (owner said yes); keep that device trusted |
| Local Docker DB copies | container `nogatu-localdb` | not carried; rebuild from a dump (DEPLOY.md 4) |

---

## 1. What we are working on
Live MLM portal for Nogatu Alliance members (thousands of members, real money). Node/Express backend + MySQL
(MariaDB) on one Hostinger VPS, React/Vite frontend on Vercel. Two backend slots: BLUE = production
(`/var/www/nogatu`, pm2 `nogatu-mlm`, port 5002, DB `nogatualliance_sysdb`) and GREEN = staging
(`/var/www/nogatu-green`, `nogatu-mlm-green`, 5003, `nogatualliance_staging`). Details: `.claude/rules/blue-green.md`.
Management contact = the DSE (company management; called "the DSE" in the rules files). The user is the developer who runs the VPS commands.

| Repo | Role | Live branch |
|---|---|---|
| Nogatu_Backend | API + income engine (`services/income/*`) | `master` -> blue; green runs `staging-aggregate-20261123-dino678` |
| Nogatu_Frontend | member portal + admin (`/portal`) | `master` -> Vercel prod; `staging` -> Vercel preview (manual promote) |

## 2. Decisions made (do not re-litigate)
- Money rules, comp plan, packages: `.claude/rules/comp-plan.md` + `money-integrity.md` (auto-loaded).
- Account handover for uid 4660003 (2026-11-24): wallet to nogatumain, unmatched PV discarded from the handover day (V052 carry
  reset), renamed. DONE on prod.
- 4 paid accounts -> CD (2026-11-23): uplines unaffected via `UPLINE_NEUTRAL_CD_UIDS`. Never remove it while any of
  the 4 is unpaid CD.
- Future questions to the DSE go in the sheet `reports/Nogatu_MLM_Questions_for_Sir_Dino.xlsx` (upload to Google
  Sheets), not PDFs (his request 2026-11-26).
- Dormant rule: build and test on staging only; hold off live (the DSE 2026-11-26).
- Voucher extension notice approved (2026-11-23); ships with items 7/8.
- Auto Upgrade decisions for Jan 2027 build: `.claude/rules/comp-plan.md`.

## 3. Lessons that matter
Full log: `.claude/rules/lessons.md` (auto-loaded, newest on top). The ones that bite most:
1. Green scripts run WITHOUT `NODE_ENV`; blue scripts WITH `NODE_ENV=production`. Read the printed `DB=` line first.
2. Out-of-band wallet writes take `GET_LOCK('nogatu_income_calc_<uid>')` + FOR UPDATE + CAS (engine lost-update).
3. Never `npm audit fix` on a server; dependency changes go branch -> tests -> green -> blue (+ differential E2E).
4. Never hand over a command with `<placeholders>`; never `rm` named paths under `/var/www/nogatu`.
5. DB admin commands use `--defaults-extra-file=/root/.nogatu-db.cnf`; credentials never in docs or chat.
6. Mask secrets token by token (a one-regex-per-line mask leaked once on 2026-11-26).

## 4. Rules
- No subagents in this project unless the owner asks. Money code: falsify (inject the bug, see the test fail).
- Blue restarts graceful only (`pm2 restart nogatu-mlm --update-env`) and only with the owner's explicit go.
- Order: backend green -> blue, then frontend (UI never ships before its API). FE staging needs a manual promote.
- Chat drafts for the DSE: casual paragraphs, no bullets. Reports for management go in `reports/`.
- Always give file paths; never print secrets or member data.

## 5. Status (2026-11-26)
**Live (blue):** backend master `a28ac36` (deps security + jsonStrings + carry reset). FE prod `f91e19b`.
**Green (staging):** deployed `1acab0b`; candidate `00f824d` built, NOT deployed.
**FE staging:** `origin/staging` = `e63ebaa` (notice banner); the pinned staging domain needs a manual promote.
**Open branches (pushed):**
- Backend `fix/bad-request-400s` `6f4b7f0` = blue `a28ac36` + bad-request 4xx fix (blue candidate).
- Backend `staging-aggregate-20261123-dino678` `00f824d` = `1acab0b` + `63e5379` (same fix) + `00f824d` (notice).
**Uncommitted WIP snapshots (local branches, travel as git bundles, not pushed):** Backend
`wip/migrate-20261126-main-backend` (8 files, old WIP on the main checkout) and `wip/migrate-20261126-codex-sept10-backend`;
Frontend `wip/migrate-20261126-codex-sept10-mlm-frontend` / `-nogatu-frontend` (3 files each). Restore with
`git stash apply <branch>` on the branch's parent commit. 9 other local-only branches (older features) also travel as bundles.
**Verified (real output, this session):** backend suites above; old code fails 18 of the new tests; local live run
on a DB copy: 8 bad-request cases 500 -> 4xx, controls unchanged; notice rehearsal on real MariaDB 10/10; FE
build OK, guard 55 -> 55, Playwright QA 1366/390 light+dark (44px dismiss, no overflow).
**NOT verified:** nothing of today on the VPS yet. Health check overdue (last 2026-08-07); money audit overdue
(last 2026-08-05).
**Waiting on the DSE:** the 11 questions in the Q&A sheet (suspended accounts PHP 62,379.85, dormant rule, Auto
Upgrade, twins, rank dates); testing items 7/8 + the notice on staging.

## 6. What's next
1. Green deploy: copy `outputs/bad-request-400s-2026-11-26/green_deploy_badreq_and_notice.sh` to `/root/`, run it, read output.
2. Vercel: promote FE `staging` `e63ebaa` so the staging domain shows the notice.
3. After green passes and the owner says go: `outputs/bad-request-400s-2026-11-26/blue_deploy_badreq.sh`; then from the PC
   merge `origin/fix/bad-request-400s` into `master` (it has this docs commit on top of `a28ac36`, so merge, never force-push).
4. System health check + weekly money audit (`.claude/rules/system-health.md`), all read-only.
5. Fix staging admin password reset to `1` (DEV_ADMIN_PASSWORD) before copying live data to staging for the DSE's tests.
6. NogatuDrop: give it its own DB password (`bash /root/rotate_db_password.sh drop commit`).
7. When answers arrive in the sheet: suspended-accounts transfer script (same pattern as the 2026-11-24 handover script in `outputs/`), suspend feature, dormant
   rule on staging.

## 7. Handoff rules for this project
- Verify on resume: in the green worktree, `node --test "tests/unit/*.test.js"` -> 1 known failure only.
- Extra scan before saving this file: none automated; check no member usernames beyond the role-level examples.
- Other repos to update together: Nogatu_Backend, Nogatu_Frontend (state lives in `.claude/rules/deploy-state.md`
  and `.codex/rules/deploy-state.md`; keep both in sync).
- After pushing: none.
- Push policy: push feature/staging branches freely; code reaches `master` only after the blue deploy succeeds.
  Handoff-only commits (`docs/HANDOFF.md`) may go to `master` any time (no CI, no auto-deploy on this repo).
