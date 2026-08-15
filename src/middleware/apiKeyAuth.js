const crypto = require('crypto');

// Guards all /api/* routes with a single shared-secret API key, sent as the
// `x-api-key` header. This is intentionally lightweight — a single household,
// not a multi-user product — but it closes the gap where anything on the
// Tailscale network could read/write real financial data with no application
// -level check at all. Full PIN/biometric auth is still planned for Phase 4
// once the mobile app exists; this is the stopgap for Phase 3 onward, when
// real SimpleFIN transaction data starts flowing through the API.
//
// Fails CLOSED: if API_KEY isn't configured, every request is rejected
// rather than silently passing through unauthenticated.
function apiKeyAuth(req, res, next) {
  const expected = process.env.API_KEY;

  if (!expected) {
    return res.status(503).json({
      error: 'Server misconfigured: API_KEY is not set. Refusing all /api requests until it is.',
    });
  }

  const provided = req.get('x-api-key') || '';

  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);

  // timingSafeEqual requires equal-length buffers; a length mismatch is
  // itself a safe, immediate "not equal" without leaking timing info.
  const matches =
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!matches) {
    return res.status(401).json({ error: 'Missing or invalid API key.' });
  }

  next();
}

module.exports = apiKeyAuth;
