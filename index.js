/**
 * NOGATU Alliance - Express Server Entry Point
 * Modern Node.js backend serving the same MySQL database as the PHP system
 */
const path = require('path');
const envFile = process.env.NODE_ENV === 'production' ? '.env.prod' : '.env.dev';
require('dotenv').config({ path: path.resolve(__dirname, envFile) });
console.log(`[Server] Loaded env: ${envFile}`);

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const cors = require('cors');
const helmet = require('helmet');
const { testConnection, pool } = require('./config/database');

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

// ─── Session store (MySQL — prevents memory leaks) ────────────
const sessionStore = new MySQLStore({
  expiration: 24 * 60 * 60 * 1000,  // 24 hours in ms
  createDatabaseTable: true,          // auto-creates sessions table if missing
  clearExpired: true,                 // auto-deletes expired sessions
  checkExpirationInterval: 15 * 60 * 1000, // clean up every 15 minutes
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data',
    },
  },
}, pool);

// Session config
app.use(session({
  secret: process.env.SESSION_SECRET || 'nogatualliance_secret',
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

// Admin routes
app.use('/api/admin/auth', require('./routes/admin/auth'));
app.use('/api/admin/dashboard', require('./routes/admin/dashboard'));
app.use('/api/admin/accounts', require('./routes/admin/accounts'));
app.use('/api/admin/codes', require('./routes/admin/codes'));
app.use('/api/admin/encashment', require('./routes/admin/encashment'));
app.use('/api/admin/redeem', require('./routes/admin/redeem'));
app.use('/api/admin/genealogy', require('./routes/admin/genealogy'));
app.use('/api/admin/news', require('./routes/admin/news'));

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
