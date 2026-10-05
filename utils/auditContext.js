const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

const middleware = (req, res, next) => als.run({
  ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
  ua: (req.headers['user-agent'] || '').slice(0, 255)
}, next);

module.exports = { middleware, get: () => als.getStore() || {} };
