// Read-only production-entry smoke against an empty disposable database.
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const assert = require('node:assert/strict');
const { PrismaClient } = require('@prisma/client');
const local = require('dotenv').parse(fs.readFileSync('.env'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const url = new URL(process.env.BOOKING_TEST_DATABASE_URL || '');
  assert(process.env.BOOKING_TEST_DISPOSABLE === '1' && url.hostname === '127.0.0.1' && url.pathname === '/neotek_booking_disposable');
  const db = new PrismaClient({ datasources: { db: { url: url.href } } });
  try { assert.equal(await db.notificationDelivery.count(), 0, 'Production smoke requires an empty outbox to prevent provider traffic'); } finally { await db.$disconnect(); }
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let output = '';
  const child = spawn(process.execPath, ['-e', "process.on('message', value => { if(value === 'stop') process.emit('SIGTERM'); }); require('./dist/src/main.js');"], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_URL: url.href, REDIS_URL: local.REDIS_URL, FRONTEND_URL: 'https://frontend.example', TRUST_PROXY: '127.0.0.1/32',
      CUSTOMER_VERIFICATION_ENCRYPTION_KEY: randomBytes(32).toString('base64'), BOOKING_ADMIN_EMAIL: 'admin@example.test', EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'no-reply@example.test', RESEND_API_KEY: 'smoke-placeholder-never-used' },
  });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) { if (child.exitCode !== null) break; try { ready = (await fetch(`http://127.0.0.1:${port}/api/health/ready`, { signal: AbortSignal.timeout(500) })).status === 200; } catch {} if (ready) break; await sleep(100); }
    assert(ready, 'Production entry did not become ready (secret diagnostics withheld)');
    for (const route of ['/auth/me', '/customer-auth/me', '/admin/bookings']) assert.equal((await fetch(`http://127.0.0.1:${port}/api${route}`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/booking/options`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/customer-auth/login`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert(!output.includes('smoke-placeholder-never-used') && !output.includes(url.href), 'Production startup leaked private configuration');
    console.log('PASS production entry: readiness, customer/admin guards, public options, exact Origin and redacted startup; no provider traffic');
  } finally {
    if (child.connected) child.send('stop');
    for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
