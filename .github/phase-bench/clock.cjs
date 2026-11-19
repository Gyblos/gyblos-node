const fs = require('node:fs');
const path = require('node:path');
const now = () => Number(process.hrtime.bigint()) / 1e6;
const rows = [];
function record(name, start, end) {
  if (process.env.GYB_PHASE_CASE) rows.push([process.env.GYB_PHASE_CASE, name, start, end]);
}
async function span(name, fn) {
  if (!process.env.GYB_PHASE_CASE) return fn();
  const start = now();
  try { return await fn(); } finally { record(name, start, now()); }
}
async function target(name, fn) {
  process.env.GYB_PHASE_CASE = name;
  try { return await span('total', fn); } finally { delete process.env.GYB_PHASE_CASE; }
}
function endpoint(ep) {
  if (!process.env.GYB_PHASE_CASE) return ep;
  let closes = 0;
  for (const [method, label] of [['close','endpoint-close'], ['connect','dial']]) {
    const original = ep[method].bind(ep);
    ep[method] = (...args) => {
      if (method === 'close') {
        const which = closes++ === 0 ? 'close-first' : 'close-again';
        return span(label, () => span(which, () => original(...args)));
      }
      return span(label, () => original(...args));
    };
  }
  return ep;
}
process.once('exit', () => {
  if (rows.length) fs.writeFileSync(path.join(process.env.GYB_PHASE_DIR, process.pid + '.json'), JSON.stringify(rows));
});
module.exports = { record, span, target, endpoint, now };
