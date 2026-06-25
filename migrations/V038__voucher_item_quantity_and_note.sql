-- V038: Product quantity on voucher availment line items + a free-text note per
-- voucher transaction (availment).
--
-- Why:
--   * Members and cashiers need to buy MULTIPLE units of a single product on one
--     voucher availment (e.g. spend a whole 2,500 voucher on 10 × a 250 product),
--     so each line item now carries quantity + unit_amount; `amount` stays the
--     LINE TOTAL (= unit_amount × quantity) and remains the money-of-record.
--   * Each availment can carry an operator/member note.
--
-- Backfill keeps existing rows exact: quantity defaults to 1 and unit_amount is
-- seeded from the existing `amount`, so unit_amount × quantity == amount for every
-- legacy row (no money figure changes).

ALTER TABLE voucher_availment_itemstab
  ADD COLUMN IF NOT EXISTS quantity   INT UNSIGNED   NOT NULL DEFAULT 1 AFTER item_label,
  ADD COLUMN IF NOT EXISTS unit_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER quantity;

-- Seed unit_amount from the historical line total (quantity is 1 for all legacy rows).
UPDATE voucher_availment_itemstab
   SET unit_amount = amount
 WHERE unit_amount = 0
   AND amount <> 0;

ALTER TABLE voucher_availmentstab
  ADD COLUMN IF NOT EXISTS note VARCHAR(500) NULL AFTER total_amount;
