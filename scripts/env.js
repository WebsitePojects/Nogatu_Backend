const fs = require('fs');
const path = require('path');

function loadBackendEnv() {
  const envFile = process.env.NODE_ENV === 'production'
    ? '.env.prod'
    : (fs.existsSync(path.resolve(__dirname, '..', '.env.development')) ? '.env.development' : '.env.dev');

  require('dotenv').config({ path: path.resolve(__dirname, '..', envFile) });
  return envFile;
}

function getDbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'nogatualliance_sysdb',
  };
}

module.exports = { loadBackendEnv, getDbConfig };
