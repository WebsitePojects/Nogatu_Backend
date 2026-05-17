/**
 * NOGATU Alliance - Express Server Entry Point
 * Modern Node.js backend serving the same MySQL database as the PHP system
 */
const path = require('path');
const fs = require('fs');

function resolveEnvFile() {
  if (process.env.NODE_ENV === 'production') {
    return '.env.prod';
  }

  // Support both naming styles used in this repo history
  const candidates = ['.env.development', '.env.dev'];
  for (const file of candidates) {
    if (fs.existsSync(path.resolve(__dirname, file))) {
      return file;
    }
  }

  return '.env.dev';
}

const envFile = resolveEnvFile();
require('dotenv').config({ path: path.resolve(__dirname, envFile) });
console.log(`[Server] Loaded env file: ${envFile}`);

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const cors = require('cors');
const helmet = require('helmet');
const { testConnection, pool } = require('./config/database');
const { requestId } = require('./utils/security');

const rateLimit = require('express-rate-limit');
const app = express();
const PORT = process.env.PORT || 5000;

// Trust Nginx reverse proxy — required for secure cookies behind HTTPS proxy
app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.requestId = requestId(req);
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

const frontendLegacyImageDir = path.resolve(__dirname, '../Nogatu_Frontend/public/legacy-img');
const legacyImageCandidates = [
  frontendLegacyImageDir,
  path.resolve(__dirname, '../public_html/img'),
  path.resolve(__dirname, '../public_html(Original_Code)/img'),
  path.resolve(__dirname, '../reference_system/public_html(latest_production_code)/img'),
];
const legacyImageDir = legacyImageCandidates.find((dir) => fs.existsSync(dir));
if (legacyImageDir) {
  app.use('/legacy-img', express.static(legacyImageDir));
  const sourceLabel = legacyImageDir === frontendLegacyImageDir ? 'frontend legacy-img assets' : 'legacy fallback images';
  console.log(`[Server] Serving ${sourceLabel} from: ${legacyImageDir}`);
} else {
  console.warn('[Server] Legacy image directory not found. /legacy-img route is disabled.');
}

const SESSION_TABLE = /^[A-Za-z0-9_]+$/.test(process.env.SESSION_TABLE || '')
  ? process.env.SESSION_TABLE
  : 'app_sessions';

// ─── Session store (MySQL — prevents memory leaks) ────────────
const sessionStore = new MySQLStore({
  expiration: 24 * 60 * 60 * 1000,  // 24 hours in ms
  createDatabaseTable: true,          // auto-creates sessions table if missing
  clearExpired: true,                 // auto-deletes expired sessions
  checkExpirationInterval: 15 * 60 * 1000, // clean up every 15 minutes
  schema: {
    tableName: SESSION_TABLE,
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data',
    },
  },
}, pool);

async function ensureSessionsTable() {
  const [tables] = await pool.query(`SHOW TABLES LIKE '${SESSION_TABLE}'`);
  if (tables.length > 0) {
    console.log(`[Server] Session table ready: ${SESSION_TABLE}`);
    return;
  }

  const createSessionsTableSql = `
    CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
      session_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
      expires int(11) unsigned NOT NULL,
      data mediumtext COLLATE utf8mb4_bin,
      PRIMARY KEY (session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
  `;

  try {
    await pool.query(createSessionsTableSql);
    console.log(`[Server] Session table ready: ${SESSION_TABLE}`);
  } catch (error) {
    if (error.code === 'ER_TABLESPACE_EXISTS') {
      console.error(`[Server] Session table create failed for ${SESSION_TABLE} due to tablespace conflict.`);
      console.error('[Server] Set SESSION_TABLE in .env.development to a new table name (example: app_sessions_v2).');
      throw error;
    }

    throw error;
  }
}

async function logAuthTableSnapshot() {
  try {
    const [[memberRows], [adminRows]] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM memberstab').then(([rows]) => rows),
      pool.query('SELECT COUNT(*) AS total FROM accesstab').then(([rows]) => rows),
    ]);

    console.log(`[Server] Auth snapshot: memberstab=${memberRows.total}, accesstab=${adminRows.total}`);

    if (Number(memberRows.total) === 0 || Number(adminRows.total) === 0) {
      console.warn('[Server] Warning: auth tables appear empty. Verify DB_NAME/credentials for this environment.');
    }
  } catch (error) {
    console.warn('[Server] Auth snapshot unavailable:', error.message);
  }
}

async function ensurePasswordColumns() {
  const [memberCols] = await pool.query(
    "SHOW COLUMNS FROM memberstab LIKE 'password'"
  );
  if (memberCols.length > 0) {
    const memberType = String(memberCols[0].Type || '').toLowerCase();
    if (!memberType.includes('varchar(255)')) {
      await pool.query('ALTER TABLE memberstab MODIFY COLUMN password VARCHAR(255) NULL');
      console.log('[Server] Updated memberstab.password to VARCHAR(255)');
    }
  }

  const [adminCols] = await pool.query(
    "SHOW COLUMNS FROM accesstab LIKE 'password'"
  );
  if (adminCols.length > 0) {
    const adminType = String(adminCols[0].Type || '').toLowerCase();
    if (!adminType.includes('varchar(255)')) {
      await pool.query('ALTER TABLE accesstab MODIFY COLUMN password VARCHAR(255) NULL');
      console.log('[Server] Updated accesstab.password to VARCHAR(255)');
    }
  }
}

async function ensureDevelopmentAdminPasswords() {
  if (process.env.NODE_ENV === 'production') return;

  const devAdminPassword = String(process.env.DEV_ADMIN_PASSWORD || '1');
  if (!devAdminPassword) return;

  const [result] = await pool.query(
    'UPDATE accesstab SET password = ? WHERE password IS NULL OR password <> ?',
    [devAdminPassword, devAdminPassword]
  );

  console.log(`[Server] Development admin passwords normalized to DEV_ADMIN_PASSWORD (${result.affectedRows} row(s) updated).`);
}

// Validate session secret
if (!process.env.SESSION_SECRET || !String(process.env.SESSION_SECRET).trim()) {
  throw new Error('SESSION_SECRET is required. Set SESSION_SECRET in the environment file.');
}

// Session config
app.use(session({
  secret: String(process.env.SESSION_SECRET),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  },
}));

// ─── Rate limiting on login endpoints ────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // Max 10 attempts per window
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', loginLimiter);
app.use('/api/admin/auth/login', loginLimiter);

// ─── API Routes ──────────────────────────────────────────────
// Member routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/genealogy', require('./routes/genealogy'));
app.use('/api/codes', require('./routes/codes'));
app.use('/api/account', require('./routes/account'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/registration', require('./routes/registration'));
app.use('/api/pairing', require('./routes/pairing'));
app.use('/api/hifive', require('./routes/hifive'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/news', require('./routes/news'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/vouchers', require('./routes/vouchers'));
app.use('/api/ranking', require('./routes/ranking'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/global-bonus', require('./routes/globalBonus'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/support', require('./routes/support'));
app.use('/api/events', require('./routes/events'));
app.use('/api/applications', require('./routes/applications').router);

// Admin routes
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/dashboard', require('./routes/admin/dashboard'));
app.use('/api/admin/accounts', require('./routes/admin/accounts'));
app.use('/api/admin/codes', require('./routes/admin/codes'));
app.use('/api/admin/encashment', require('./routes/admin/encashment'));
app.use('/api/admin/redeem', require('./routes/admin/redeem'));
app.use('/api/admin/hifive', require('./routes/admin/hifive'));
app.use('/api/admin/genealogy', require('./routes/admin/genealogy'));
app.use('/api/admin/news', require('./routes/admin/news'));
app.use('/api/admin/vouchers', require('./routes/admin/vouchers'));
app.use('/api/admin/voucher-management', require('./routes/admin/voucherManagement'));
app.use('/api/admin/rankings', require('./routes/admin/rankings'));
app.use('/api/admin/global-bonus', require('./routes/admin/globalBonus'));
app.use('/api/admin/messages', require('./routes/admin/messages'));
app.use('/api/admin/cd-accounts', require('./routes/admin/cdAccounts'));
app.use('/api/admin/applications', require('./routes/admin/applications'));
app.use('/api/admin/cd-accounts', require('./routes/admin/cdAccounts'));
app.use('/api/admin/voucher-management', require('./routes/admin/voucherManagement'));

// ─── Serve React build in production ─────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

// ─── Error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────────
async function start() {
  await testConnection();
  await ensurePasswordColumns();
  await ensureDevelopmentAdminPasswords();
  await logAuthTableSnapshot();
  await ensureSessionsTable();

  // Wait for store internals to be ready before accepting requests.
  if (typeof sessionStore.onReady === 'function') {
    await sessionStore.onReady();
  }

  const server = app.listen(PORT, () => {
    console.log(`[Server] NOGATU Alliance running on http://localhost:${PORT}`);
    console.log(`[Server] API available at http://localhost:${PORT}/api`);
    console.log(`[Server] Mode: ${process.env.NODE_ENV || 'development'}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n[Server] Port ${PORT} is already in use.`);
      console.error('[Server] Stop the process using this port, or set a different PORT in your .env file.');
      console.error('[Server] On Windows, run: netstat -ano | findstr :5000, then taskkill /PID <pid> /F\n');
      process.exit(1);
    }

    console.error('[Server] Failed to start server:', error);
    process.exit(1);
  });
}

start().catch((error) => {
  console.error('[Server] Startup failed:', error);
  process.exit(1);
});
