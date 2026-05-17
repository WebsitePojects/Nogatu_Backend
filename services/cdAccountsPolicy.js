function toNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function deriveCdSettlementState(account = {}) {
  const cdAmount = toNumber(account.cdamount);
  const cdTotal = toNumber(account.cdtotal);
  const totalCdDeduction = toNumber(account.totalCdDeduction);
  const remaining = Math.max(0, cdAmount - cdTotal);
  const recoveredRemaining = Math.max(0, cdAmount - totalCdDeduction);
  const isRecoveredFullyPaid = cdAmount > 0 && totalCdDeduction >= cdAmount;
  const isSettledOutsideDeduction = !isRecoveredFullyPaid && cdAmount > 0 && (
    toNumber(account.cdstatus) === 2 || remaining <= 0
  );

  let statusLabel = 'Unpaid';
  if (isRecoveredFullyPaid) {
    statusLabel = 'Fully Paid';
  } else if (isSettledOutsideDeduction) {
    statusLabel = 'Settled Outside Deduction';
  }

  return {
    cdAmount,
    cdTotal,
    totalCdDeduction,
    remaining,
    recoveredRemaining,
    isRecoveredFullyPaid,
    isSettledOutsideDeduction,
    statusLabel,
  };
}

module.exports = {
  deriveCdSettlementState,
};
