/* Read-only DB checks. Build in an owned temp directory, preserving watch dist. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'neotek-phase-c-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set();
const run = command => spawnSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: owned, windowsHide: true, encoding: 'utf8' });
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function main() {
  assert.equal(process.platform, 'win32', 'This local harness uses Windows npm/signal adaptation');
  try {
    for (const name of ['src', 'scripts', 'prisma', 'package.json', 'nest-cli.json', 'tsconfig.json', 'tsconfig.build.json'])
      fs.cpSync(path.join(root, name), path.join(owned, name), { recursive: true });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(owned, 'node_modules'), 'junction');
    const build = run('npm.cmd run build');
    assert.equal(build.status, 0, 'Isolated default Nest build failed');
    assert(fs.existsSync(path.join(owned, 'dist/src/main.js')));
    console.log('PASS isolated npm run build: dist/src/main.js');
    const invalidMode = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run start:prod'], { cwd: owned, windowsHide: true, encoding: 'utf8', env: { ...process.env, NODE_ENV: '' } });
    assert.notEqual(invalidMode.status, 0);
    assert(invalidMode.stderr.includes('NODE_ENV=production'));
    console.log('PASS start:prod rejects missing production mode before dependencies');
    const preload = path.join(owned, 'test-control.cjs');
    fs.writeFileSync(preload, `
      if (process.argv.length === 1) {
        require('reflect-metadata');
        for (const [file, name, marker] of [['cache/cache.service','CacheService','REDIS'],['prisma/prisma.service','PrismaService','PRISMA']]) {
          const prototype = require('./dist/src/'+file+'.js')[name].prototype;
          const close = prototype.onModuleDestroy;
          prototype.onModuleDestroy = async function() { await close.call(this); console.log('CLOSED_'+marker); };
        }
        process.stdin.on('data', data => {
          const event = data.toString().trim();
          if (event === 'SIGTERM' || event === 'SIGINT') process.emit(event);
          else if (event === 'FATAL') process.emit('uncaughtException', new Error('fixture-secret-dsn'));
          else if (event === 'REJECTION') process.emit('unhandledRejection', new Error('fixture-secret-dsn'));
        });
      }
    `);
    const local = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient({ datasourceUrl: local.DATABASE_URL });
    let records;
    try { records = await db.page.findMany({ where: { slug: { in: ['home', 'solutions', 'admin-test', 'unknown', 'nhan-su-tien-luong'] } }, select: { slug: true, status: true } }); }
    finally { await db.$disconnect(); }
    const expected = new Map(records.map(page => [page.slug, page.status === 'PUBLISHED' ? 200 : 404]));
    for (const event of ['SIGTERM', 'SIGINT', 'FATAL', 'REJECTION', 'REDIS_DOWN', 'DB_DOWN']) {
      const port = await freePort();
      let output = '';
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run start:prod'], {
        cwd: owned, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...local, NODE_ENV: 'production', PORT: String(port),
          FRONTEND_URL: 'https://frontend.example', TRUST_PROXY: '127.0.0.1/32',
          ...(event === 'REDIS_DOWN' ? { REDIS_URL: `redis://127.0.0.1:${await freePort()}` } : {}),
          ...(event === 'DB_DOWN' ? { DATABASE_URL: `postgresql://fixture:fixture-secret-dsn@127.0.0.1:${await freePort()}/neotek?connect_timeout=1&pool_timeout=2` } : {}),
          NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"` },
      });
      children.add(child);
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const base = `http://127.0.0.1:${port}/api`;
      if (event === 'DB_DOWN') {
        for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) await pause(100);
        assert.notEqual(child.exitCode, null, 'DB startup failure was not bounded');
        assert.notEqual(child.exitCode, 0);
        assert(!output.includes('fixture-secret-dsn'), 'DB startup leaked DSN');
        console.log('PASS required DB startup failure: nonzero exit, bounded and redacted');
        children.delete(child);
        continue;
      }
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (child.exitCode !== null) break;
        try { ready = (await fetch(`${base}/health/${event === 'REDIS_DOWN' ? 'live' : 'ready'}`, { signal: AbortSignal.timeout(1500) })).status === 200; } catch {}
        if (ready) break;
        await pause(200);
      }
      assert(ready, 'Production readiness did not become healthy; secret diagnostics withheld');
      assert.equal((await fetch(`${base}/health/live`)).status, 200);
      assert.equal((await fetch(`${base}/auth/me`)).status, 401);
      assert.equal((await fetch(`${base}/admin/pages`)).status, 401);
      if (event === 'REDIS_DOWN') {
        const degraded = await fetch(`${base}/health/ready`);
        assert.equal(degraded.status, 503);
        assert.deepEqual(await degraded.json(), { statusCode: 503, status: 'error', database: 'up', cache: 'down' });
        assert.equal((await fetch(`${base}/admin/pages`, { headers: { Cookie: '__Host-neotek_admin_session=' + 's'.repeat(43) } })).status, 500);
        assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { Origin: 'https://frontend.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'fixture@example.test', password: 'fixture-password' }) })).status, 503);
      }
      assert.equal((await fetch(`${base}/auth/login`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
      for (const slug of ['home', 'solutions', 'admin-test', 'unknown'])
        assert.equal((await fetch(`${base}/pages/${slug}?locale=vi`)).status, expected.get(slug) || 404, `Publication policy for ${slug}`);
      assert.equal((await fetch(`${base}/pages/nhan-su-tien-luong?locale=vi`)).status, expected.get('nhan-su-tien-luong') || 404);
      child.stdin.write((event === 'REDIS_DOWN' ? 'SIGTERM' : event) + '\n');
      for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) await pause(100);
      assert.notEqual(child.exitCode, null, 'Production process did not terminate within deadline');
      assert(!output.includes('fixture-secret-dsn'), 'Fatal diagnostic leaked a secret');
      if (event.startsWith('SIG') || event === 'REDIS_DOWN') {
        assert(output.includes('CLOSED_REDIS') && output.includes('CLOSED_PRISMA'), 'Shutdown hooks did not complete');
        console.log(`PASS start:prod port=${port}; ${event} Nest handler completed Prisma/Redis close`);
      } else {
        assert.notEqual(child.exitCode, 0);
        assert(output.includes('supervisor restart required'));
        console.log(`PASS ${event}: nonzero exit and redacted fatal diagnostic`);
      }
      children.delete(child);
      await assert.rejects(fetch(`${base}/health/live`, { signal: AbortSignal.timeout(1000) }));
    }
    console.log('Windows test emits signal events into the real Nest handlers; native Linux/container signal delivery remains Phase D.');
  } finally {
    for (const child of children) if (child.exitCode === null && Number.isInteger(child.pid))
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    assert.equal(path.dirname(owned), path.resolve(os.tmpdir()));
    assert(path.basename(owned).startsWith('neotek-phase-c-'));
    const junction = path.join(owned, 'node_modules');
    if (fs.existsSync(junction)) { assert(fs.lstatSync(junction).isSymbolicLink()); fs.unlinkSync(junction); }
    fs.rmSync(owned, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
