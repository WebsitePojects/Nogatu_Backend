/**
 * Legacy code-trail parsing (codehistorytab.history).
 *
 * Codes generated before activation_code_usagetab existed have NO usage events —
 * their entire transfer trail lives only in this string. Two formats are stored:
 *
 *  1. Parenthesised (admin / legacy PHP):
 *       "(nogatuadmin)Ann050890 -> (Ann050890)Malou05"
 *     Each segment is self-contained: "(actor)recipient".
 *  2. Plain (Node member transfer, routes/codes.js writes `${username}->${target}`):
 *       "tabsqui->VernieS01"
 *     Segments are usernames: from -> to.
 *
 * Anything reading trails MUST handle both, or format 2 silently yields nothing.
 */

function parseLegacySegments(history) {
  if (!history) return [];
  const raw = String(history).trim();
  if (!raw) return [];
  const parts = raw.split('->').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return [];

  if (raw.includes('(')) {
    return parts.map((p) => ({
      actor: (p.match(/^\(([^)]+)\)/) || [])[1]?.trim() || null,
      recipient: (p.match(/\)\s*(.+)$/) || [])[1]?.trim() || null,
    }));
  }
  // Plain chain "a->b->c" = a gave to b, b gave to c.
  const segs = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    segs.push({ actor: parts[i], recipient: parts[i + 1] });
  }
  return segs;
}

/** First transfer of the code: { actor, recipient, full } or null. */
function parseLegacyTrail(history) {
  const segs = parseLegacySegments(history);
  if (segs.length === 0) return null;
  return { actor: segs[0].actor, recipient: segs[0].recipient, full: String(history).trim() };
}

const sameUser = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

module.exports = { parseLegacySegments, parseLegacyTrail, sameUser };
