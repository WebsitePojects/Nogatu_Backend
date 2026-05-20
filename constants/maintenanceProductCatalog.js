const MAINTENANCE_PRODUCT_CATALOG = [
  { code: 100, voucherKey: 'bl', hifiveKey: 'bl', name: 'Nogatu Barley Juice', price: 850, incentivePoints: 50 },
  { code: 101, voucherKey: 'gl', hifiveKey: 'gl', name: 'Nogatu Glow', price: 550, incentivePoints: 45 },
  { code: 102, voucherKey: 'glc', hifiveKey: 'glc', name: 'Vitamin C with Collagen & Glutathione', price: 500, incentivePoints: 40 },
  { code: 103, voucherKey: 'cm', hifiveKey: 'cm', name: 'Nogatu Coffee Mix', price: 495, incentivePoints: 40 },
  { code: 104, voucherKey: 'cd', hifiveKey: 'cd', name: 'Chocolate Drink Mix', price: 710, incentivePoints: 45 },
  { code: 105, voucherKey: 'mgt', hifiveKey: 'mgt', name: 'Mangosteen Coffee Mix', price: 375, incentivePoints: 30 },
  { code: 106, voucherKey: 'vc', hifiveKey: 'vz', name: 'Vitamin C with Zinc & Mangosteen', price: 580, incentivePoints: 40 },
  { code: 107, voucherKey: 'cmm', hifiveKey: 'cmm', name: 'Nogatu Max Fuel Coffee Drink Mix', price: 2500, incentivePoints: 100 },
  { code: 108, voucherKey: 'bkc', hifiveKey: 'bkc', name: 'Nogatu Black Coffee', price: 250, incentivePoints: 10 },
  { code: 109, voucherKey: 'bnad', hifiveKey: 'bnad', name: 'Berry NAD+', price: 7998, incentivePoints: 35 },
];

const MAINTENANCE_PRODUCT_TYPES = Object.fromEntries(
  MAINTENANCE_PRODUCT_CATALOG.map((product) => [product.code, product.name])
);

const MAINTENANCE_PRODUCT_CONFIG = Object.fromEntries(
  MAINTENANCE_PRODUCT_CATALOG.map((product) => [
    product.code,
    {
      name: product.name,
      directreferral: 0,
      binarypoints: 0,
      unilevelpoints: product.incentivePoints,
      incentivepoints: 0,
      profitsharing: 0,
      productamount: product.price,
    },
  ])
);

const VOUCHER_PRODUCT_CATALOG = Object.fromEntries(
  MAINTENANCE_PRODUCT_CATALOG.map((product) => [
    product.voucherKey,
    {
      code: product.code,
      name: product.name,
      price: product.price,
      incentivePoints: product.incentivePoints,
    },
  ])
);

const HIFIVE_PRODUCT_TYPE_TO_KEY = Object.fromEntries(
  MAINTENANCE_PRODUCT_CATALOG.map((product) => [product.code, product.hifiveKey])
);

const HIFIVE_PRODUCT_METADATA = Object.fromEntries(
  MAINTENANCE_PRODUCT_CATALOG.map((product) => [
    product.hifiveKey,
    {
      code: product.code,
      name: product.name,
      purchasePoints: product.incentivePoints,
      price: product.price,
    },
  ])
);

module.exports = {
  MAINTENANCE_PRODUCT_CATALOG,
  MAINTENANCE_PRODUCT_TYPES,
  MAINTENANCE_PRODUCT_CONFIG,
  VOUCHER_PRODUCT_CATALOG,
  HIFIVE_PRODUCT_TYPE_TO_KEY,
  HIFIVE_PRODUCT_METADATA,
};
