/**
 * AR network rule: "bawal bumili kung hindi within your network ang binilhan".
 *
 * Codes bought on an AR may go only to the buyer or to someone in the buyer's BINARY downline
 * (`usertab.refid`, decided 2026-10-01). We walk UP from the recipient rather than DOWN from the
 * buyer: the upward chain is one primary-key hop per level, while a downward walk would visit the
 * buyer's entire subtree.
 */

// Binary chains can run far deeper than the 100 levels services/leaders.js allows. The cap only
// guards against a corrupt cycle; a legitimate chain this deep would still resolve correctly.
const MAX_BINARY_DEPTH = 5000;

const BINARY_ANCESTORS_SQL = `
  WITH RECURSIVE chain AS (
    SELECT uid, refid AS parent_uid, 0 AS depth
      FROM usertab WHERE uid = ?
    UNION ALL
    SELECT p.uid, p.refid, c.depth + 1
      FROM usertab p
      JOIN chain c ON p.uid = c.parent_uid AND p.uid <> c.uid
     WHERE c.depth < ${MAX_BINARY_DEPTH}
  )
  SELECT 1 AS found FROM chain WHERE uid = ? LIMIT 1`;

/**
 * True when `recipientUid` is the buyer or sits anywhere under the buyer in the binary tree.
 * Fails closed: a missing or non-positive uid is never "in network".
 */
async function isInBinaryNetwork(conn, buyerUid, recipientUid) {
  const buyer = Number(buyerUid);
  const recipient = Number(recipientUid);
  if (!Number.isInteger(buyer) || buyer <= 0 || !Number.isInteger(recipient) || recipient <= 0) return false;
  if (buyer === recipient) return true;
  const [rows] = await conn.query(BINARY_ANCESTORS_SQL, [recipient, buyer]);
  return rows.length > 0;
}

module.exports = { isInBinaryNetwork, MAX_BINARY_DEPTH, BINARY_ANCESTORS_SQL };
