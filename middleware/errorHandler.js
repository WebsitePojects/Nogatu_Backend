/**
 * Final Express error handler.
 *
 * Errors raised while reading the request body (express.json / express.urlencoded,
 * i.e. body-parser) carry an HTTP status of their own: 400 for malformed JSON or a
 * corrupt gzip body, 413 for a body over the size limit, 415 for an unknown
 * Content-Encoding. They describe a bad REQUEST, so they must reach the client as
 * that 4xx instead of a 500 that reads as a server fault (and pages whoever watches
 * the error log). Everything else stays a generic 500.
 *
 * Only http-errors marked `expose` with a 4xx status are passed through, and the
 * response text is ours, never err.message, so no parser internals leak.
 */
const { STATUS_CODES } = require('node:http');

const CLIENT_ERROR_MESSAGES = {
  400: 'Invalid request body',
  413: 'Request body too large',
  415: 'Unsupported request encoding',
};

function clientErrorStatus(err) {
  const status = Number(err && (err.status || err.statusCode));
  if (!Number.isInteger(status) || status < 400 || status > 499) return null;
  // http-errors sets expose=true for 4xx; a plain Error that merely carries a
  // `status` property is not trusted to pick the response code.
  return err.expose === true ? status : null;
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = clientErrorStatus(err);
  if (status) {
    console.warn('[Client Error]', status, err.type || 'client_error', req.method, req.originalUrl || req.url);
    return res.status(status).json({ error: CLIENT_ERROR_MESSAGES[status] || STATUS_CODES[status] || 'Bad request' });
  }

  console.error('[Server Error]', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { errorHandler, clientErrorStatus };
