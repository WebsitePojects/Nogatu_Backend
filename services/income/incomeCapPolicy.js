function toNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getStoredIncomeTotal(storedTotals = {}) {
  return (
    toNumber(storedTotals.ttlincome1) +
    toNumber(storedTotals.ttlincome2) +
    toNumber(storedTotals.ttlincome3) +
    toNumber(storedTotals.ttlincome4) +
    toNumber(storedTotals.ttlincome5) +
    toNumber(storedTotals.ttlincome6)
  );
}

function getLifetimeIncomeHeadroom({ packagePolicy = {}, storedTotals = {} }) {
  const ceiling = toNumber(packagePolicy.lifetimeIncomeCeiling);
  if (ceiling <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, ceiling - getStoredIncomeTotal(storedTotals));
}

function applyLifetimeIncomeCeiling({ packagePolicy = {}, storedTotals = {}, proposedIncome = {} }) {
  const categories = ['dref', 'paircash', 'leadership', 'unilevel', 'hifive', 'lpc'];
  const allowedIncome = {
    dref: 0,
    paircash: 0,
    leadership: 0,
    unilevel: 0,
    hifive: 0,
    lpc: 0,
  };

  const ceiling = toNumber(packagePolicy.lifetimeIncomeCeiling);
  const normalizedProposed = categories.reduce((acc, key) => {
    acc[key] = toNumber(proposedIncome[key]);
    return acc;
  }, {});

  if (ceiling <= 0) {
    return {
      packageLabel: packagePolicy.packageLabel || null,
      lifetimeIncomeCeiling: 0,
      baseStoredTotals: { ...storedTotals },
      headroomBefore: Number.POSITIVE_INFINITY,
      headroomAfter: Number.POSITIVE_INFINITY,
      allowedIncome: normalizedProposed,
      allowedTotal: categories.reduce((sum, key) => sum + normalizedProposed[key], 0),
      blockedTotal: 0,
      blockedByCeiling: false,
    };
  }

  let remaining = getLifetimeIncomeHeadroom({ packagePolicy, storedTotals });

  for (const key of categories) {
    const proposal = normalizedProposed[key];
    if (remaining <= 0) {
      allowedIncome[key] = 0;
      continue;
    }
    const allowed = Math.min(proposal, remaining);
    allowedIncome[key] = allowed;
    remaining -= allowed;
  }

  const proposedTotal = categories.reduce((sum, key) => sum + normalizedProposed[key], 0);
  const allowedTotal = categories.reduce((sum, key) => sum + allowedIncome[key], 0);

  return {
    packageLabel: packagePolicy.packageLabel || null,
    lifetimeIncomeCeiling: ceiling,
    baseStoredTotals: { ...storedTotals },
    headroomBefore: getLifetimeIncomeHeadroom({ packagePolicy, storedTotals }),
    headroomAfter: remaining,
    allowedIncome,
    allowedTotal,
    blockedTotal: Math.max(0, proposedTotal - allowedTotal),
    blockedByCeiling: proposedTotal > allowedTotal,
  };
}

module.exports = {
  getStoredIncomeTotal,
  getLifetimeIncomeHeadroom,
  applyLifetimeIncomeCeiling,
};
