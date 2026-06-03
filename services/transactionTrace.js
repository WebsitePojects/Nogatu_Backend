function normalizeAmount(value) {
  return Number(value || 0);
}

function normalizeDateValue(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date;
}

function toCents(value) {
  return Math.round(normalizeAmount(value) * 100);
}

function compareCandidateSets(left, right) {
  if (!left) return 1;
  if (!right) return -1;

  if (left.rows.length !== right.rows.length) {
    return left.rows.length - right.rows.length;
  }

  if (left.totalDistance !== right.totalDistance) {
    return left.totalDistance - right.totalDistance;
  }

  return right.latestTs - left.latestTs;
}

function pickRowsByExactAmount(rows = [], targetAmount = 0, cutoffValue = null, options = {}) {
  const amountKey = options.amountKey || 'amount';
  const dateKey = options.dateKey || 'transdate';
  const maxCandidates = Math.min(24, Math.max(6, Number(options.maxCandidates) || 18));
  const maxRows = Math.min(8, Math.max(1, Number(options.maxRows) || 6));
  const targetCents = toCents(targetAmount);
  if (targetCents <= 0) return [];

  const cutoff = normalizeDateValue(cutoffValue);
  const candidates = rows
    .map((row) => {
      const amount = toCents(row[amountKey]);
      const rowDate = normalizeDateValue(row[dateKey]);
      const timeDistance = cutoff && rowDate
        ? Math.abs(cutoff.getTime() - rowDate.getTime())
        : Number.MAX_SAFE_INTEGER;

      return {
        ...row,
        __amountCents: amount,
        __timeDistance: timeDistance,
        __rowDate: rowDate,
      };
    })
    .filter((row) => row.__amountCents > 0)
    .filter((row) => !cutoff || (row.__rowDate && row.__rowDate.getTime() <= cutoff.getTime()))
    .sort((left, right) => {
      if (left.__timeDistance !== right.__timeDistance) {
        return left.__timeDistance - right.__timeDistance;
      }
      return new Date(right[dateKey] || 0) - new Date(left[dateKey] || 0);
    })
    .slice(0, maxCandidates);

  let best = null;

  function search(index, pickedRows, runningCents, totalDistance, latestTs) {
    if (runningCents === targetCents) {
      const candidate = { rows: [...pickedRows], totalDistance, latestTs };
      if (compareCandidateSets(best, candidate) > 0) {
        best = candidate;
      }
      return;
    }

    if (index >= candidates.length || runningCents > targetCents || pickedRows.length >= maxRows) {
      return;
    }

    for (let cursor = index; cursor < candidates.length; cursor += 1) {
      const row = candidates[cursor];
      const nextCents = runningCents + row.__amountCents;
      if (nextCents > targetCents) {
        continue;
      }
      const rowTime = row.__rowDate ? row.__rowDate.getTime() : 0;
      pickedRows.push(row);
      search(
        cursor + 1,
        pickedRows,
        nextCents,
        totalDistance + row.__timeDistance,
        Math.max(latestTs, rowTime)
      );
      pickedRows.pop();
    }
  }

  search(0, [], 0, 0, 0);
  return best ? best.rows.map(({ __amountCents, __timeDistance, __rowDate, ...row }) => row) : [];
}

module.exports = {
  normalizeAmount,
  normalizeDateValue,
  pickRowsByExactAmount,
};
