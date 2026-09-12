const { getEffectiveAccountState } = require('./accountState');

const POLICY_CODE_TYPES = Object.freeze({ PD: 1, FS: 2, CD: 3 });

function normalizeUid(uid) {
  const value = Number(uid);
  if (!Number.isInteger(value) || value <= 0) throw new Error('Invalid member ID');
  return value;
}

function classifyEffectiveCodeType(state) {
  const codeType = Number(state?.codeid || 0);
  if (![1, 2, 3].includes(codeType)) return 'UNKNOWN';
  return codeType === 1 ? 'PD' : codeType === 2 ? 'FS' : 'CD';
}

async function resolveVoucherAccountPolicy(conn, uid, suppliedState = null) {
  if (!conn || typeof conn.query !== 'function') throw new Error('Voucher policy requires a database connection');
  const memberUid = normalizeUid(uid);
  const state = await getEffectiveAccountState(memberUid, suppliedState || null, conn);
  const effectiveCodeType = classifyEffectiveCodeType(state);
  const upgradeStateUnknown = state && Number(state.accttype || 0) < Number(state.currentaccttype || 0)
    && ![1, 2, 3].includes(Number(state.upgrade_codetype || 0));
  if (!state || effectiveCodeType === 'UNKNOWN' || upgradeStateUnknown) {
    return { uid: memberUid, known: false, allowed: false, effectiveCodeType: 'UNKNOWN', reason: 'unknown_effective_account_state', state: null };
  }
  return {
    uid: memberUid, known: true, allowed: effectiveCodeType !== 'CD', effectiveCodeType,
    reason: effectiveCodeType === 'CD' ? 'cd_accounts_have_no_digital_vouchers' : 'eligible_account_type', state,
  };
}

async function assertVoucherPolicyAllowed(conn, uid, action) {
  const result = await resolveVoucherAccountPolicy(conn, uid);
  if (!result.known) {
    const error = new Error('Unable to determine the member account state');
    error.code = 'VOUCHER_ACCOUNT_STATE_UNKNOWN';
    throw error;
  }
  if (!result.allowed) {
    const error = new Error('Digital voucher ' + (action || 'operation') + ' is not allowed for CD accounts');
    error.code = 'CD_VOUCHER_POLICY_BLOCKED';
    error.effectiveCodeType = result.effectiveCodeType;
    throw error;
  }
  return result;
}

module.exports = { POLICY_CODE_TYPES, classifyEffectiveCodeType, resolveVoucherAccountPolicy, assertVoucherPolicyAllowed };
