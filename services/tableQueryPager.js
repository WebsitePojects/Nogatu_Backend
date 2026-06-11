class TableQueryPager {
  constructor(queryExecutor) {
    if (!queryExecutor || typeof queryExecutor.query !== 'function') {
      throw new Error('TableQueryPager requires a query executor with a query(sql, params) method');
    }
    this.queryExecutor = queryExecutor;
  }

  normalizePage(page = 1, perPage = 30, maxPerPage = 100) {
    const safePerPage = Math.max(1, Math.min(maxPerPage, Number(perPage) || 30));
    const safePage = Math.max(1, Number(page) || 1);
    return {
      page: safePage,
      perPage: safePerPage,
      offset: (safePage - 1) * safePerPage,
    };
  }

  async fetchPage({
    page = 1,
    perPage = 30,
    maxPerPage = 100,
    countSql,
    countParams = [],
    dataSql,
    dataParams = [],
  }) {
    const normalized = this.normalizePage(page, perPage, maxPerPage);
    const [countRows] = await this.queryExecutor.query(countSql, countParams);
    const total = Number(countRows[0]?.total || 0);
    const [rows] = await this.queryExecutor.query(
      `${dataSql} LIMIT ?, ?`,
      [...dataParams, normalized.offset, normalized.perPage]
    );

    return {
      rows,
      pagination: {
        page: normalized.page,
        perPage: normalized.perPage,
        total,
        totalPages: Math.max(1, Math.ceil(total / normalized.perPage)),
      },
    };
  }

  async fetchByKeys({
    rows = [],
    rowKey,
    queryFactory,
    keyField,
    mode = 'array',
    mapRow = (row) => row,
  }) {
    const keys = Array.from(new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => row?.[rowKey])
        .filter((value) => value !== undefined && value !== null && value !== '')
    ));

    if (keys.length === 0) {
      return new Map();
    }

    const placeholders = keys.map(() => '?').join(',');
    const [relatedRows] = await this.queryExecutor.query(queryFactory(placeholders), keys);
    const grouped = new Map();

    for (const row of relatedRows) {
      const key = row?.[keyField];
      if (key === undefined || key === null || key === '') continue;

      const mapped = mapRow(row);
      if (mode === 'first') {
        if (!grouped.has(key)) {
          grouped.set(key, mapped);
        }
        continue;
      }

      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push(mapped);
    }

    return grouped;
  }
}

module.exports = {
  TableQueryPager,
};
