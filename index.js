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

  if (process.env.NODE_ENV === 'staging') {
    return '.env.staging';
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
const {
  SCHEMA_REQUIREMENTS,
  assertSchemaRequirements,
  getSchemaSnapshot,
  listMissingSchemaRequirements,
} = require('./services/schemaReadiness');
const { requestId } = require('./utils/security');

const rateLimit = require('express-rate-limit');
const app = express();
const PORT = process.env.PORT || 5000;
const readinessState = {
  startedAt: new Date().toISOString(),
  dbReady: false,
  schemaReady: false,
  sessionStoreReady: false,
  startupComplete: false,
};

function parseAllowedOrigins(...values) {
  return [...new Set(
    values
      .flatMap((value) => String(value || '').split(','))
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

function buildCspDirectives(allowedOrigins) {
  const directives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    fontSrc: ["'self'", 'data:', 'https:'],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
    connectSrc: ["'self'", ...allowedOrigins],
    formAction: ["'self'", ...allowedOrigins],
  };

  if (process.env.NODE_ENV === 'production') {
    directives.upgradeInsecureRequests = [];
  }

  return directives;
}

const allowedOrigins = parseAllowedOrigins(
  process.env.ALLOWED_ORIGINS,
  process.env.CLIENT_URL,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174'
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  return allowedOrigins.includes(String(origin).trim());
}

function getRequestOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin) return origin;

  const referer = String(req.headers.referer || '').trim();
  if (!referer) return '';

  try {
    return new URL(referer).origin;
  } catch {
    return '';
  }
}

// Trust Nginx reverse proxy — required for secure cookies behind HTTPS proxy
app.set('trust proxy', 1);

// ─── Middleware ───────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: buildCspDirectives(allowedOrigins),
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    console.warn('[CORS] Rejected origin:', origin);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.requestId = requestId(req);
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

console.log('[Server] Legacy image static serving is disabled in the backend. Frontend public assets should serve /legacy-img directly.');

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

app.use((req, res, next) => {
  const method = String(req.method || 'GET').toUpperCase();
  const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const hasSessionActor = Boolean(req.session?.uid || req.session?.adminid);

  if (!isMutating || !hasSessionActor) {
    return next();
  }

  const origin = getRequestOrigin(req);
  if (!origin || isAllowedOrigin(origin)) {
    return next();
  }

  return res.status(403).json({ error: 'Invalid request origin' });
});

// ─── Rate limiting on login endpoints ────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,                   // Max 50 attempts per window
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
// readonlyGuard blocks all non-GET requests for accounts with role='readonly'
const { readonlyGuard } = require('./middleware/auth');
app.use('/api/admin', readonlyGuard);

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
app.use('/api/admin/finance', require('./routes/admin/finance'));
app.use('/api/admin/applications', require('./routes/admin/applications'));
app.use('/api/admin/support', require('./routes/admin/support'));
app.use('/api/admin/view-as', require('./routes/admin/viewAs'));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    startedAt: readinessState.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/ready', async (_req, res) => {
  const checks = {
    db: false,
    schema: false,
    sessions: readinessState.sessionStoreReady,
    startup: readinessState.startupComplete,
  };
  let missing = [];

  try {
    await pool.query('SELECT 1 AS ok');
    checks.db = true;
  } catch {}

  try {
    const snapshot = await getSchemaSnapshot();
    missing = listMissingSchemaRequirements(snapshot, SCHEMA_REQUIREMENTS.READINESS);
    checks.schema = missing.length === 0;
  } catch {}

  const ready = Object.values(checks).every(Boolean);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
    missing,
  });
});

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
  readinessState.dbReady = true;
  await assertSchemaRequirements(SCHEMA_REQUIREMENTS.AUTH_PASSWORDS, 'Authentication');
  readinessState.schemaReady = true;
  await ensureDevelopmentAdminPasswords();
  await logAuthTableSnapshot();
  await ensureSessionsTable();

  // Wait for store internals to be ready before accepting requests.
  if (typeof sessionStore.onReady === 'function') {
    await sessionStore.onReady();
  }
  readinessState.sessionStoreReady = true;

  const server = app.listen(PORT, () => {
    readinessState.startupComplete = true;
    console.log(`[Server] NOGATU Alliance running on http://localhost:${PORT}`);
    console.log(`[Server] API available at http://localhost:${PORT}/api`);
    console.log(`[Server] Mode: ${process.env.NODE_ENV || 'development'}`);
    // Start the background job worker (durable job_queuetab poller: support orphan
    // upload cleanup, etc.). Safe to no-op if Cloudinary is unconfigured.
    try { require('./services/jobWorker').startWorker(); } catch (e) { console.error('[Server] jobWorker start failed:', e.message); }
    // Signal PM2 that the process is ready (used by wait_ready in ecosystem.config.js)
    if (process.send) process.send('ready');
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

  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('[Server] Startup failed:', error);
    process.exit(1);
  });
}

module.exports = { app, start, readinessState };
