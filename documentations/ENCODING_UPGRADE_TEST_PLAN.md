# Encoding & Upgrade — Staging Validation Plan

Pre-production behavior validation. Encode through the **real gates** (admin
generates the code → register via **open slot** or **referral link**), then run
the **read-only** verification SQL below and send the output back for sign-off.

- DB: `nogatualliance_staging` (green). All SQL here is **SELECT-only** — it changes nothing.
- Codes: generate in **Admin → Generate Codes** (PD/FS/CD at the package you need). Do **not** hand-insert codes.
- Two gates to exercise: **(G1)** open-slot manual registration, **(G2)** referral link.

Account-type legend: `codeid` 1=PD, 2=FS, 3=CD · `position`/leg 1=Left, 2=Right ·
`cdstatus` 1=unpaid, 2=settled.

Contribution rule being validated (from `services/accountState.js` →
`countsForPairingSource`): **only PD or fully-paid CD (cdstatus=2 & cdtotal≥cdamount)
feed binary points upward.** FS and unpaid-CD do not. The engine passes *through*
them to reach eligible deeper nodes.

---

## Verification Toolkit — run after EVERY scenario

```sql
-- Set the encoded member's username, then run the four SELECTs.
SET @user := 'TESTUSER';
SET @uid  := (SELECT uid FROM memberstab WHERE username = @user);

-- 1) Account state + placement + whether it contributes binary points
SELECT u.uid, m.username,
       u.refid  AS binary_parent, u.position AS leg_1L_2R, u.drefid AS sponsor,
       u.codeid AS code_1PD_2FS_3CD,
       u.accttype AS orig_pkg, u.currentaccttype AS curr_pkg,
       u.cdamount, u.cdtotal, u.cdstatus, u.binarypoints,
       CASE WHEN u.codeid=1 THEN 'CONTRIBUTES (PD)'
            WHEN u.codeid=3 AND u.cdstatus=2 AND u.cdtotal>=u.cdamount THEN 'CONTRIBUTES (CD settled)'
            WHEN u.codeid=2 THEN 'no-contribute (FS)'
            WHEN u.codeid=3 THEN 'no-contribute (CD unpaid)'
            ELSE '??' END AS pairing_source
FROM usertab u JOIN memberstab m ON m.uid=u.uid WHERE u.uid=@uid;

-- 2) Closure: member sits under every upline with the correct leg, to the root
SELECT c.depth, am.username AS ancestor, c.leg
FROM binary_tree_closuretab c JOIN memberstab am ON am.uid=c.ancestor_uid
WHERE c.descendant_uid=@uid ORDER BY c.depth;

-- 3) Binary point events (registration + each upgrade)
SELECT event_type, leg, package_type, point_value, event_ts
FROM binary_point_eventstab
WHERE source_member_uid=@uid AND deleted_at IS NULL ORDER BY event_ts;

-- 4) Upgrade rows (upgrade scenarios only)
SELECT producttype, binarypoints, transtype, transdate
FROM upgradetab WHERE uid=@uid ORDER BY transdate;
```

To confirm an **upline actually received** the new member's PV, open that
upline's Pairing Reports (or):
```sql
SET @upline := 'UPLINE_USERNAME';
SELECT ROUND(ttlincome2) AS smb_total
FROM payouttotaltab WHERE uid=(SELECT uid FROM memberstab WHERE username=@upline);
-- record before encoding and after the upline next opens Pairing Reports.
```

---

## Part A — Registration (encoding) scenarios

| # | Code | Package | Gate | Expect codeid | binarypoints | pairing_source |
|---|------|---------|------|--------|------|----------------|
| A1 | PD | Bronze (10)   | G1 open slot, pick **Left**  | 1 | 250   | CONTRIBUTES |
| A2 | PD | Platinum (40) | G2 referral link             | 1 | 2500  | CONTRIBUTES |
| A3 | FS | Gold (30)     | G1 open slot, pick **Right** | 2 | 1000  | no (FS) |
| A4 | CD | Silver (20)   | G2 referral link             | 3, cdstatus=1 | 500 | no (CD unpaid) |
| A5 | PD | Diamond (60)  | G1 open slot                 | 1 | 15000 | CONTRIBUTES |
| A6 | CD | Bronze (10)   | G1 open slot                 | 3, cdstatus=1 | 250 | no (CD unpaid) |

**Expected for all A:** `binary_parent`/`leg` match the slot you chose (G1) or the
auto-recommended weak-leg under the sponsor (G2); `sponsor` = the referrer/selected
sponsor; closure (#2) lists the member under every upline to the root with a
consistent leg; one `registration` event (#3) with `point_value` = the package value.
Only A1, A2, A5 should later raise an upline's `ttlincome2`; A3/A4/A6 must not.

---

## Part B — Upgrade scenarios (encode as PD/FS/CD first, then upgrade)

Upgrade gate: member logs in → uses an upgrade code at a **higher** package.
Current PV model is **additive** (matches live PHP): original registration PV
stays, the upgrade fires the **new package's full** PV as a separate event. (The
delta model — firing new − old — is a separate, not-yet-built change.)

| # | Start state | Upgrade code | Expect codeid | curr_pkg | cd fields (amt/total/status) | upgrade event point_value | pairing_source AFTER |
|---|-------------|--------------|--------|------|------|------|----------------------|
| B1 | PD Bronze | PD Platinum | 1 | 40 | 0 / 0 / 0 | 2500 | CONTRIBUTES (250 + 2500 = 2750 total) |
| B2 | CD Bronze (unpaid) | PD Platinum (paid) | 1 | 40 | settled → cdstatus **2** | 2500 | CONTRIBUTES (CD treated settled) |
| B3 | PD Bronze | CD Platinum | 3 | 40 | 25000 / 0 / **1** (fresh) | 2500 | **STOPS** (now CD unpaid) |
| B4 | CD Bronze (unpaid) | CD Platinum | 3 | 40 | 25000 / **0** / 1 (paid reset to 0) | 2500 | no (CD unpaid) |
| B5 | FS Bronze | PD Platinum | 1 | 40 | 0 / 0 / 0 | 2500 | CONTRIBUTES (now eligible) |
| B6 | CD Bronze (unpaid) | FS Platinum | 2 | 40 | 0 / 0 / 0 | 2500 | no (FS) |

**Key behaviors to confirm:**
- **B2** — paid upgrade on a CD account settles the old CD immediately (`cdstatus=2`) so it starts contributing.
- **B3** — PD→CD makes the account **stop** contributing (CD unpaid). Already-credited upline income is **not** clawed back (monotonic `Math.max`), but future pairing won't count this node until the new CD is settled.
- **B4** — CD→CD to a higher package **resets `cdtotal` to 0** and sets a fresh `cdamount` = the new package.
- All B — `accttype` (original) stays unchanged; only `currentaccttype` moves to the new package, which is exactly how the engine detects an upgrade.

---

## Sign-off checklist
- [ ] A1–A6 placement + codeid + binarypoints + closure-to-root + registration event
- [ ] A1/A2/A5 raise an eligible upline's `ttlincome2`; A3/A4/A6 do not
- [ ] B1–B6 codeid/curr_pkg/cd-fields + upgrade event + post-upgrade contribution
- [ ] Both gates exercised (open slot **and** referral link)
