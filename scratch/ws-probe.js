/* WS-001/002/003 probe. Usage: node scratch/ws-probe.js <label> <url> */
const WebSocket = require('ws');
const [label, url] = process.argv.slice(2);
const ws = new WebSocket(url);
let settled = false;
const done = (msg) => { if (!settled) { settled = true; console.log(`  ${label.padEnd(40)} ${msg}`); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 100); } };
ws.on('open',  () => done('ACCEPTED'));
ws.on('close', (c, r) => done(`REJECTED code=${c} ${String(r) || ''}`));
ws.on('error', (e) => done(`ERROR ${e.message}`));
setTimeout(() => done('TIMEOUT (no open/close)'), 6000);
