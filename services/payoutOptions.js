const PAYOUT_OPTION_DEFINITIONS = [
  { id: 1, label: 'Pickup', aliases: ['pickup'] },
  { id: 2, label: 'GCash', aliases: ['gcash', 'g cash', 'gcash'] },
  { id: 3, label: 'Remittance Center', aliases: ['remittance center', 'remittance centers'] },
  { id: 4, label: 'Bank Deposit', aliases: ['bank deposit'] },
  { id: 5, label: 'Others', aliases: ['others', 'other'] },
  { id: 6, label: 'PSBank', aliases: ['psbank', 'ps bank'] },
];

const PAYOUT_OPTION_BY_ID = PAYOUT_OPTION_DEFINITIONS.reduce((acc, option) => {
  acc[option.id] = option;
  return acc;
}, {});

const PAYOUT_OPTION_BY_KEY = PAYOUT_OPTION_DEFINITIONS.reduce((acc, option) => {
  acc[option.label.toLowerCase()] = option;
  for (const alias of option.aliases) {
    acc[String(alias || '').trim().toLowerCase()] = option;
  }
  return acc;
}, {});

function normalizePayoutLookupKey(rawValue) {
  return String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function resolvePayoutOption(rawValue, { allowUnknown = false } = {}) {
  if (rawValue == null) return null;

  const trimmed = String(rawValue).trim();
  if (!trimmed) return null;

  const numericId = Number(trimmed);
  if (Number.isFinite(numericId) && PAYOUT_OPTION_BY_ID[numericId]) {
    const option = PAYOUT_OPTION_BY_ID[numericId];
    return {
      id: option.id,
      label: option.label,
      storageValue: option.label,
      raw: trimmed,
    };
  }

  const option = PAYOUT_OPTION_BY_KEY[normalizePayoutLookupKey(trimmed)];
  if (option) {
    return {
      id: option.id,
      label: option.label,
      storageValue: option.label,
      raw: trimmed,
    };
  }

  if (!allowUnknown) {
    return null;
  }

  return {
    id: null,
    label: trimmed,
    storageValue: trimmed,
    raw: trimmed,
  };
}

function normalizePayoutStorageValue(rawValue) {
  return resolvePayoutOption(rawValue, { allowUnknown: true })?.storageValue || null;
}

function listPayoutOptions() {
  return PAYOUT_OPTION_DEFINITIONS.map((option) => ({
    id: option.id,
    label: option.label,
  }));
}

module.exports = {
  PAYOUT_OPTION_DEFINITIONS,
  resolvePayoutOption,
  normalizePayoutStorageValue,
  listPayoutOptions,
};
