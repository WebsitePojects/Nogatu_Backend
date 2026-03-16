/**
 * Database Configuration
 * Reads connection settings from .env.dev or .env.prod (loaded by index.js)
 */
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nogatualliance_sysdb',
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log(`[DB] Connected to MySQL - ${process.env.DB_NAME}@${process.env.DB_HOST} (${process.env.NODE_ENV || 'development'})`);
    conn.release();
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = { pool, testConnection };
