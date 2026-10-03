// Small shared HTTP helpers used by the request handler and proxy.

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 * @param {string} [type]
 */
export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    req.on('data', (/** @type {Buffer} */ chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > limit) {
        settled = true;
        data = '';
        const error = /** @type {Error & { statusCode?: number }} */ (new Error('request body too large'));
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (!settled) resolve(data);
    });
    req.on('error', reject);
  });
}
