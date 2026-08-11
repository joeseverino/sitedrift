// Small shared HTTP helpers used by the request handler and proxy.

export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > limit) {
        settled = true;
        data = '';
        const error = new Error('request body too large');
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
