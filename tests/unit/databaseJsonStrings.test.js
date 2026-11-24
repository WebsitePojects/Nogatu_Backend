// The pool must keep JSON columns as strings (see config/database.js). Without the option, mysql2
// 3.24 hands back objects and every JSON.parse(row.jsonColumn) in the code breaks.
const test = require('node:test');
const assert = require('node:assert/strict');

test('database pool keeps JSON columns as strings (jsonStrings: true)', () => {
  const mysqlPath = require.resolve('mysql2/promise');
  const dbPath = require.resolve('../../config/database');
  const savedMysql = require.cache[mysqlPath];
  let captured = null;
  require.cache[mysqlPath] = {
    id: mysqlPath,
    filename: mysqlPath,
    loaded: true,
    exports: { createPool: (opts) => { captured = opts; return {}; } },
  };
  delete require.cache[dbPath];
  try {
    require('../../config/database');
    assert.ok(captured, 'createPool was called');
    assert.equal(captured.jsonStrings, true);
  } finally {
    delete require.cache[dbPath];
    if (savedMysql) require.cache[mysqlPath] = savedMysql; else delete require.cache[mysqlPath];
  }
});
