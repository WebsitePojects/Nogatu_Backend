const TAX_RATE = 0.10;
const PROCESSING_FEE = 50;
const MAINTENANCE_FEE = 20;
const CD_DEDUCTION_RATE = 0.25;
const { resolvePayoutOption } = require('../services/payoutOptions');

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function calculateEncashmentBreakdown({
  amount,
  cdRemaining = 0,
  isCdDeductionActive = false,
  processingFee = PROCESSING_FEE,
  maintenanceFee = MAINTENANCE_FEE,
} = {}) {
  const gross = roundMoney(amount);
  if (!Number.isFinite(gross) || gross <= 0) {
    throw new Error('Invalid encashment amount');
  }

  const tax = roundMoney(gross * TAX_RATE);
  const cdDeduction = isCdDeductionActive
    ? roundMoney(Math.min(gross * CD_DEDUCTION_RATE, Math.max(0, Number(cdRemaining || 0))))
    : 0;
  const totalDeductions = roundMoney(tax + processingFee + maintenanceFee + cdDeduction);
  const net = roundMoney(gross - totalDeductions);

  return {
    gross,
    tax,
    taxRate: TAX_RATE,
    processingFee: roundMoney(processingFee),
    maintenanceFee: roundMoney(maintenanceFee),
    cdDeduction,
    totalDeductions,
    net,
  };
}

function validatePayoutDetails({ payoutId, payoutDetails } = {}) {
  const resolvedPayout = resolvePayoutOption(payoutId, { allowUnknown: false });
  const normalizedDetails = String(payoutDetails || '').trim();

  if (!resolvedPayout) {
    return {
      ok: false,
      code: 'PAYOUT_OPTION_REQUIRED',
      message: 'Verify your account by adding a payout option before encashment.',
    };
  }

  if (!normalizedDetails) {
    return {
      ok: false,
      code: 'PAYOUT_DETAILS_REQUIRED',
      message: 'Verify your account by adding payment details before encashment.',
    };
  }

  return {
    ok: true,
    payoutId: resolvedPayout.id,
    payoutLabel: resolvedPayout.label,
    payoutStorageValue: resolvedPayout.storageValue,
    payoutDetails: normalizedDetails,
  };
}

module.exports = {
  TAX_RATE,
  PROCESSING_FEE,
  MAINTENANCE_FEE,
  CD_DEDUCTION_RATE,
  roundMoney,
  calculateEncashmentBreakdown,
  validatePayoutDetails,
};
