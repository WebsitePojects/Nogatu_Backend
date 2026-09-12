const crypto = require('crypto');
const { pool } = require('../config/database');

function normalizeErNumber(value) {
  const er = String(value || '').trim();
  if (!/^VREQ-[0-9]+-[0-9]+$/.test(er)) throw new Error('Invalid voucher request reference');
  return er;
}
function money(value) { const n = Number(value); if (!Number.isFinite(n)) throw new Error('Invalid monetary value'); return Math.round(n * 100) / 100; }
function correctionKey(action, erNumber) { return 'voucher-request:' + action + ':' + normalizeErNumber(erNumber); }
function manifestHash(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => ({
    erNumber: normalizeErNumber(row.erNumber), uid: Number(row.uid), amount: money(row.amount), voucherId: Number(row.voucherId), transactionId: Number(row.transactionId), paymentMethod: String(row.paymentMethod || ''), cashPaid: money(row.cashPaid), voucherUsed: money(row.voucherUsed), claimStatus: String(row.claimStatus || ''),
  })).sort((a, b) => a.erNumber.localeCompare(b.erNumber));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
async function loadLockedRequest(conn, erNumber) {
  const [rows] = await conn.query(
    'SELECT a.*, vt.id AS linked_transaction_id, vt.uid AS transaction_uid, vt.voucher_id AS transaction_voucher_id, vt.availment_id AS transaction_availment_id, vt.cash_paid, vt.voucher_used, vt.total_value, vt.source_type, vt.external_reference ' +
    'FROM voucher_availmentstab a LEFT JOIN voucher_transactionstab vt ON vt.id = a.transaction_id ' +
    'WHERE a.er_number = ? ORDER BY a.id ASC FOR UPDATE', [normalizeErNumber(erNumber)]);
  if (rows.length !== 1) throw new Error(rows.length ? 'Voucher request reference is ambiguous' : 'Voucher request not found');
  const request = rows[0];
  if (Number(request.linked_transaction_id) <= 0 || Number(request.voucher_id) <= 0 || Number(request.uid) <= 0) throw new Error('Voucher request linkage is invalid');
  if (Number(request.transaction_uid) !== Number(request.uid) || Number(request.transaction_voucher_id) !== Number(request.voucher_id) || Number(request.transaction_availment_id) !== Number(request.id)) throw new Error('Voucher transaction linkage is invalid');
  if (String(request.source_type || '') !== 'voucher_product_request') throw new Error('Voucher transaction source is not a member request');
  if (String(request.request_source || '') !== 'member' || String(request.external_reference || '') !== String(request.er_number)) throw new Error('Voucher request source linkage is invalid');
  request.transaction_id = Number(request.linked_transaction_id);
  return request;
}
async function cancelVoucherRequest({ erNumber, expectedUid = null, expectedAmount = null, actorAdmin = 'support-repair', reason = 'management cancellation', manifestHashValue = null, poolOverride = pool }) {
  const safeEr = normalizeErNumber(erNumber);
  const conn = await poolOverride.getConnection();
  let lockAcquired = false; let txStarted = false;
  let lockKey = 'nogatu_income_calc_' + safeEr;
  try {
    const [uidRows] = await conn.query('SELECT uid FROM voucher_availmentstab WHERE er_number = ? ORDER BY id ASC LIMIT 1', [safeEr]);
    if (uidRows.length) lockKey = 'nogatu_income_calc_' + Number(uidRows[0].uid);
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS lockState', [lockKey]);
    lockAcquired = Number(lockRows[0]?.lockState || 0) === 1;
    if (!lockAcquired) throw new Error('Unable to lock voucher request');
    await conn.beginTransaction(); txStarted = true;
    const request = await loadLockedRequest(conn, safeEr);
    if (!request) throw new Error('Voucher request not found');
    if (expectedUid != null && Number(request.uid) !== Number(expectedUid)) throw new Error('Voucher request member mismatch');
    if (expectedUid == null || expectedAmount == null) throw new Error('Expected member and amount are required');
    if (money(request.total_amount) !== money(expectedAmount)) throw new Error('Voucher request amount mismatch');
    const key = correctionKey('cancel', safeEr);
    if (String(request.claim_status || '').toLowerCase() !== 'requested') throw new Error('Only requested voucher entries can be cancelled');
    if (!request.transaction_id) throw new Error('Voucher request has no reversible transaction');
    const [voucherRows] = await conn.query('SELECT * FROM voucherstab WHERE id = ? LIMIT 1 FOR UPDATE', [request.voucher_id]);
    const voucher = voucherRows[0]; if (!voucher) throw new Error('Voucher record not found');
    if (Number(voucher.uid) !== Number(request.uid)) throw new Error('Voucher member linkage is invalid');
    const paymentMethod = String(request.payment_method || '').toLowerCase();
    if (paymentMethod !== 'wallet') throw new Error('Only wallet transactions are eligible for this correction');
    const recordedCash = money(request.cash_paid); const recordedVoucher = money(request.voucher_used); const requestTotal = money(request.total_amount);
    if (recordedCash <= 0 || recordedVoucher <= 0 || recordedCash !== recordedVoucher || recordedCash !== requestTotal || recordedCash !== money(expectedAmount)) throw new Error('Recorded transaction amounts do not match the approved amount');
    const voucherRefund = recordedVoucher;
    const cashRefund = recordedCash;
    const beforeRemaining = money(voucher.remaining_balance); const voucherAmount = money(voucher.voucher_amount);
    if (beforeRemaining < 0 || voucherAmount <= 0 || beforeRemaining + voucherRefund > voucherAmount) throw new Error('Voucher refund exceeds voucher face value');
    const restoredRemaining = money(beforeRemaining + voucherRefund);
    const originalStatus = Number(voucher.status);
    if (![1, 2, 3, 4, 5].includes(originalStatus)) throw new Error('Unknown voucher status');
    const expired = voucher.expiry_date && new Date(voucher.expiry_date).getTime() < Date.now();
    const restoredStatus = originalStatus === 3 ? (expired ? 2 : 1) : originalStatus;
    let walletBefore = null; let walletAfter = null;
    if (cashRefund > 0) {
      const [walletRows] = await conn.query('SELECT ttlcashbalance FROM payouttotaltab WHERE uid = ? LIMIT 1 FOR UPDATE', [request.uid]);
      if (!walletRows.length) throw new Error('Member wallet row not found');
      walletBefore = money(walletRows[0].ttlcashbalance); walletAfter = money(walletBefore + cashRefund);
      const [walletUpdate] = await conn.query('UPDATE payouttotaltab SET ttlcashbalance = ?, transdate = NOW() WHERE uid = ? LIMIT 1', [walletAfter, request.uid]);
      if (Number(walletUpdate.affectedRows) !== 1) throw new Error('Wallet update was not applied');
    }
    if (voucherRefund > 0) {
      const [voucherUpdate] = await conn.query('UPDATE voucherstab SET remaining_balance = ?, status = ?, redeemed_date = CASE WHEN ? = 1 THEN NULL ELSE redeemed_date END WHERE id = ? AND status = ?', [restoredRemaining, restoredStatus, restoredStatus, request.voucher_id, originalStatus]);
      if (Number(voucherUpdate.affectedRows) !== 1) throw new Error('Voucher balance update was not applied');
    }
    await conn.query("INSERT INTO voucher_transactionstab (uid, voucher_id, cash_paid, voucher_used, total_value, transaction_date, source_type, availment_id, external_reference) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), 'voucher_request_cancellation', ?, ?)", [request.uid, request.voucher_id, -cashRefund, -voucherRefund, -(cashRefund + voucherRefund), request.id, key]);
    const [requestUpdate] = await conn.query("UPDATE voucher_availmentstab SET claim_status = 'cancelled', updated_by_admin = ? WHERE id = ? AND claim_status = 'requested'", [actorAdmin, request.id]);
    if (Number(requestUpdate.affectedRows) !== 1) throw new Error('Voucher request state changed during cancellation');
    await conn.query("INSERT INTO voucher_availment_audittab (availment_id, voucher_id, action_type, actor_admin, snapshot_before, snapshot_after) VALUES (?, ?, 'cancelled', ?, ?, ?)", [request.id, request.voucher_id, actorAdmin, JSON.stringify({ claimStatus: request.claim_status, remaining: voucher.remaining_balance }), JSON.stringify({ claimStatus: 'cancelled', remaining: restoredRemaining, cashRefund, voucherRefund })]);
    await conn.commit(); txStarted = false;
    return { idempotent: false, erNumber: safeEr, uid: Number(request.uid), cashRefund, voucherRefund };
  } catch (error) { if (txStarted) await conn.rollback(); throw error; }
  finally { if (lockAcquired) await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]).catch(() => {}); conn.release(); }
}
async function reopenVoucherRequest({ erNumber, expectedUid = null, expectedAmount = null, actorAdmin = 'support-repair', reason = 'management reopen', poolOverride = pool }) {
  const safeEr = normalizeErNumber(erNumber); const conn = await poolOverride.getConnection(); let txStarted = false; let lockAcquired = false; let lockKey = 'nogatu_income_calc_' + safeEr;
  try {
    const [uidRows] = await conn.query('SELECT uid FROM voucher_availmentstab WHERE er_number = ? ORDER BY id ASC LIMIT 1', [safeEr]);
    if (uidRows.length) lockKey = 'nogatu_income_calc_' + Number(uidRows[0].uid);
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 10) AS lockState', [lockKey]);
    lockAcquired = Number(lockRows[0]?.lockState || 0) === 1;
    if (!lockAcquired) throw new Error('Unable to lock voucher request');
    await conn.beginTransaction(); txStarted = true; const request = await loadLockedRequest(conn, safeEr);
    if (!request) throw new Error('Voucher request not found');
    if (expectedUid != null && Number(request.uid) !== Number(expectedUid)) throw new Error('Voucher request member mismatch');
    if (expectedUid == null || expectedAmount == null || money(request.total_amount) !== money(expectedAmount)) throw new Error('Expected member and amount are required');
    const key = correctionKey('reopen', safeEr);
    if (String(request.claim_status || '').toLowerCase() !== 'claimed') throw new Error('Only claimed voucher entries can be reopened');
    const [reopenUpdate] = await conn.query("UPDATE voucher_availmentstab SET claim_status = 'requested', claimed_at = NULL, claimed_by_admin_id = NULL, claimed_by_admin = NULL, updated_by_admin = ? WHERE id = ? AND claim_status = 'claimed'", [actorAdmin, request.id]);
    if (Number(reopenUpdate.affectedRows) !== 1) throw new Error('Voucher request state changed during reopen');
    await conn.query("INSERT INTO voucher_availment_audittab (availment_id, voucher_id, action_type, actor_admin, snapshot_before, snapshot_after) VALUES (?, ?, 'reopened', ?, ?, ?)", [request.id, request.voucher_id, actorAdmin, JSON.stringify({ claimStatus: 'claimed' }), JSON.stringify({ claimStatus: 'requested' })]);
    await conn.commit(); txStarted = false; return { idempotent: false, erNumber: safeEr };
  } catch (error) { if (txStarted) await conn.rollback(); throw error; } finally { if (lockAcquired) await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]).catch(() => {}); conn.release(); }
}
module.exports = { normalizeErNumber, correctionKey, manifestHash, cancelVoucherRequest, reopenVoucherRequest };
