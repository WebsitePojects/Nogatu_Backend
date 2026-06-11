const test = require('node:test');
const assert = require('node:assert/strict');

const { TableQueryPager } = require('../../services/tableQueryPager');

test('table query pager paginates base rows and hydrates only the current page keys', async () => {
  const calls = [];
  const executor = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });

      if (sql.startsWith('SELECT COUNT(*) AS total FROM usertab')) {
        return [[{ total: 100 }]];
      }

      if (sql.startsWith('SELECT u.uid, m.username FROM usertab')) {
        return [[
          { uid: 901, username: 'alpha' },
          { uid: 902, username: 'beta' },
        ]];
      }

      if (sql.startsWith('SELECT uid, id, status FROM voucherstab')) {
        return [[
          { uid: 901, id: 11, status: 1 },
          { uid: 902, id: 12, status: 4 },
        ]];
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const pager = new TableQueryPager(executor);

  const page = await pager.fetchPage({
    page: 2,
    perPage: 2,
    countSql: 'SELECT COUNT(*) AS total FROM usertab',
    dataSql: 'SELECT u.uid, m.username FROM usertab u INNER JOIN memberstab m ON m.uid = u.uid ORDER BY u.datereg DESC',
  });

  const vouchersByUid = await pager.fetchByKeys({
    rows: page.rows,
    rowKey: 'uid',
    queryFactory: (placeholders) => `SELECT uid, id, status FROM voucherstab WHERE uid IN (${placeholders}) ORDER BY uid ASC, id DESC`,
    keyField: 'uid',
    mode: 'first',
  });

  assert.equal(page.pagination.page, 2);
  assert.equal(page.pagination.perPage, 2);
  assert.equal(page.pagination.total, 100);
  assert.equal(page.pagination.totalPages, 50);
  assert.deepEqual(page.rows, [
    { uid: 901, username: 'alpha' },
    { uid: 902, username: 'beta' },
  ]);

  assert.equal(vouchersByUid.get(901).id, 11);
  assert.equal(vouchersByUid.get(902).status, 4);

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].params, [2, 2]);
  assert.deepEqual(calls[2].params, [901, 902]);
});

test('table query pager skips related lookups when the current page has no keys', async () => {
  const executor = {
    query: async (sql) => {
      if (sql.startsWith('SELECT COUNT(*) AS total FROM voucherstab')) {
        return [[{ total: 0 }]];
      }
      if (sql.startsWith('SELECT id FROM voucherstab')) {
        return [[]];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const pager = new TableQueryPager(executor);
  const page = await pager.fetchPage({
    page: 1,
    perPage: 30,
    countSql: 'SELECT COUNT(*) AS total FROM voucherstab',
    dataSql: 'SELECT id FROM voucherstab ORDER BY id DESC',
  });

  const related = await pager.fetchByKeys({
    rows: page.rows,
    rowKey: 'id',
    queryFactory: (placeholders) => `SELECT id FROM voucher_transactionstab WHERE voucher_id IN (${placeholders})`,
    keyField: 'id',
  });

  assert.equal(page.rows.length, 0);
  assert.equal(related.size, 0);
});
