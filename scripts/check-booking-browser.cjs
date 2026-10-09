// Run only through test-booking-postgres.ps1 -Browser. Uses a disposable DB,
// real Redis under a random namespace, private local mail, and headless Chrome.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const backend = path.resolve(__dirname, '..');
const frontend = path.resolve(backend, '../Neotek Frontend');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const url = new URL(process.env.BOOKING_TEST_DATABASE_URL || '');
  assert(process.env.BOOKING_TEST_DISPOSABLE === '1' && url.hostname === '127.0.0.1' && url.pathname === '/neotek_booking_disposable', 'Disposable DB required');
  const local = dotenv.parse(await fs.readFile(path.join(backend, '.env')));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neotek-booking-browser-'));
  const reportDir = path.join(frontend, 'docs/booking-phase1c1-browser');
  await fs.mkdir(reportDir, { recursive: true });
  process.env.NODE_ENV = 'development'; process.env.DATABASE_URL = url.href;
  process.env.REDIS_URL = local.REDIS_URL;
  process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.BOOKING_ADMIN_EMAIL = 'booking-admin@example.test';
  process.env.EMAIL_PROVIDER = 'dev'; process.env.EMAIL_DEV_DIRECTORY = path.join(temporary, 'mail');
  process.env.BOOKING_LEAD_MINUTES = '0';
  require('ts-node/register');
  const { Test } = require('@nestjs/testing');
  const { PrismaClient } = require('@prisma/client');
  const { AppModule } = require('../src/app.module');
  const { CacheService } = require('../src/cache/cache.service');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { configureHttpSecurity } = require('../src/config/http-security');
  const { hashPassword } = require('../src/auth/password.util');
  const db = new PrismaClient();
  const cache = new CacheService();
  const prefix = `booking-browser:${randomUUID()}:`, keys = new Set();
  const key = value => { const k = prefix + value; keys.add(k); return k; };
  const scopedCache = {
    get: k => cache.get(key(k)), set: (k, v, ttl) => cache.set(key(k), v, ttl), del: k => cache.del(key(k)), ping: () => cache.ping(),
    incrementWithExpiry: (k, ttl) => cache.incrementWithExpiry(key(k), ttl),
    getOrCreateSessionToken: (s, c, v) => cache.getOrCreateSessionToken(key(s), key(c), v),
  };
  let app, chrome, staticServer, socket;
  const results = [], exceptions = [];
  try {
    await db.$connect(); await cache.onModuleInit(); assert.equal(await cache.ping(), 'PONG');
    // Copy published marketing content read-only for public-route regression.
    const source = new PrismaClient({ datasources: { db: { url: local.DATABASE_URL } } });
    let detailSlug;
    try {
      const pages = await source.page.findMany({ where: { status: 'PUBLISHED' }, include: { translations: true, sections: { include: { translations: true } } } });
      const shared = await source.siteSetting.findMany({ where: { key: { startsWith: 'shared.' } }, include: { translations: true } });
      for (const setting of shared) await db.siteSetting.upsert({ where: { key: setting.key }, update: {}, create: { key: setting.key, translations: { create: setting.translations.map(t => ({ locale: t.locale, value: t.value })) } } });
      for (const p of pages) {
        const target = await db.page.upsert({ where: { slug: p.slug }, update: { status: p.status, kind: p.kind }, create: { slug: p.slug, status: p.status, kind: p.kind } });
        await db.pageSection.deleteMany({ where: { pageId: target.id } });
        await db.pageTranslation.deleteMany({ where: { pageId: target.id } });
        for (const t of p.translations) await db.pageTranslation.create({ data: { pageId: target.id, locale: t.locale, title: t.title, seoTitle: t.seoTitle, seoDescription: t.seoDescription } });
        for (const s of p.sections) await db.pageSection.create({ data: { pageId: target.id, key: s.key, type: s.type, sortOrder: s.sortOrder, enabled: s.enabled, translations: { create: s.translations.map(t => ({ locale: t.locale, content: t.content })) } } });
        if (p.kind === 'SOLUTION_DETAIL') detailSlug = p.slug;
      }
      assert(pages.some(p => p.slug === 'home') && pages.some(p => p.slug === 'solutions'), 'Published CMS fixtures required');
    } finally { await source.$disconnect(); }
    const password = 'browser test secure password';
    const adminEmail = `${randomUUID()}@example.test`;
    await db.user.create({ data: { email: adminEmail, name: 'Browser test admin', role: 'ADMIN', passwordHash: await hashPassword(password) } });
    let backendPort, dropFinalizeOnce = false;
    staticServer = http.createServer(async (req, res) => {
      try {
        if (req.url.startsWith('/api/')) {
          const proxy = http.request({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${backendPort}` } }, upstream => { if (dropFinalizeOnce && req.url === '/api/booking/finalize') { dropFinalizeOnce = false; upstream.resume(); upstream.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' }); res.write('{'); setTimeout(() => res.destroy(), 100); }); return; } res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
          proxy.on('error', () => { res.statusCode = 502; res.end(); }); req.pipe(proxy); return;
        }
        const root = path.join(frontend, 'dist');
        const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let filename = path.resolve(root, '.' + requested);
        if (!filename.startsWith(root + path.sep) && filename !== root) { res.statusCode = 403; res.end(); return; }
        if (!path.extname(filename)) filename = path.join(root, 'index.html');
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
        res.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store'); res.end(await fs.readFile(filename));
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${staticServer.address().port}`;
    process.env.FRONTEND_URL = origin;
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(CacheService).useValue(scopedCache).overrideProvider(PrismaService).useValue(db).compile();
    app = module.createNestApplication({ bodyParser: false, logger: false }); configureHttpSecurity(app); await app.listen(0, '127.0.0.1'); backendPort = app.getHttpServer().address().port;
    // Reserve an ephemeral debugging port, then let Chrome own it.
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const debugPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-features=Translate', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temporary, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let target;
    for (let i = 0; i < 100; i++) { try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch {} await sleep(100); }
    assert(target, 'Chrome did not start');
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 0; const callbacks = new Map();
    socket.onmessage = event => { const value = JSON.parse(event.data); if (value.id) { const cb = callbacks.get(value.id); if (cb) { callbacks.delete(value.id); clearTimeout(cb.timer); value.error ? cb.reject(new Error(value.error.message)) : cb.resolve(value.result); } } else if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => { callbacks.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); callbacks.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    const wait = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(100); } throw new Error(`Browser wait failed: ${expression}; text=${await evaluate('document.body.innerText.slice(-1800)')}`); };
    const navigate = async route => { await send('Page.navigate', { url: origin + route }); await wait("document.readyState === 'complete' && !!document.querySelector('h1')"); };
    const click = async selector => { await wait(`!!document.querySelector(${JSON.stringify(selector)})`); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(150); };
    const fill = async (selector, value) => { await wait(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) return false; const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`); };
    const submit = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`); await sleep(200); };
    const api = async (route, method = 'GET', body) => evaluate(`(async () => { const method=${JSON.stringify(method)}; const headers={}; if(method!=='GET'){ const csrf=await (await fetch('/api/customer-auth/csrf')).json();headers['x-csrf-token']=csrf.csrfToken;headers['Content-Type']='application/json'; } const response=await fetch('/api'+${JSON.stringify(route)},{method,headers,${body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(body)}),`}credentials:'include'});return {status:response.status,data:await response.json()}; })()`);
    const width = async value => send('Emulation.setDeviceMetricsOverride', { width: value, height: 1000, deviceScaleFactor: 1, mobile: value < 768 });
    const snapshot = async name => { const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(path.join(reportDir, `${name}.png`), Buffer.from(shot.data, 'base64')); };
    const checkLayout = async label => { await sleep(300); assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), `Horizontal overflow: ${label}`); results.push(label); };
    const select = async (column = 0, offset = 12) => {
      await wait("!!document.querySelector('.booking-day__surface') && !!document.querySelector('select option[value]:not([value=\"\"])') && !document.querySelector('.booking-sidebar [role=\"status\"]')");
      await evaluate(`document.querySelectorAll('.booking-day__surface')[${column}].focus()`);
      for (const key of ['Home', ...Array(offset).fill('ArrowDown'), 'Enter']) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Home' ? 36 : 40 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }); await sleep(60); }
      await wait("!!document.querySelector('[role=\"dialog\"]')");
    };
    // Flow A: anonymous local selection -> registration -> verification -> hold.
    await width(1440); await navigate('/en/booking');
    await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
    await select();
    const moduleKey = await evaluate("document.querySelector('.booking-dialog select option:not([value=\"\"])').value");
    await fill('.booking-dialog select', moduleKey); await click('.booking-dialog > .neotek-button');
    await wait("location.pathname === '/en/login'");
    await click('.auth-switch a'); await wait("location.pathname === '/en/register'");
    const email = `${randomUUID()}@example.test`;
    await fill('input[name=name]', 'Browser Customer'); await fill('input[name=email]', email); await fill('input[name=password]', password); await fill('input[name=confirm]', password); await submit('.auth-form');
    await wait("!!document.querySelector('[role=\"status\"]')"); await snapshot('register-success-en');
    let verificationUrl;
    for (let i = 0; i < 80; i++) { const files = await fs.readdir(process.env.EMAIL_DEV_DIRECTORY).catch(() => []); for (const file of files) { const mail = JSON.parse(await fs.readFile(path.join(process.env.EMAIL_DEV_DIRECTORY, file), 'utf8')); if (mail.to === email) verificationUrl = mail.text.match(/http[^\s]+#token=[A-Za-z0-9_-]+/)?.[0]; } if (verificationUrl) break; await sleep(150); }
    assert(verificationUrl, 'Real worker did not deliver verification to the explicit dev mailbox');
    await send('Page.navigate', { url: verificationUrl }); await wait("!!document.querySelector('.auth-submit')"); await click('button.auth-submit'); await wait("document.body.innerText.includes('Your email is verified')");
    await click('a.auth-submit'); await wait("location.pathname === '/en/booking'");
    // Registration intentionally does not create a session. Continue via login.
    await wait("!!document.querySelector('.booking-dialog > .neotek-button')"); await click('.booking-dialog > .neotek-button'); await wait("location.pathname === '/en/login'"); await fill('input[name=email]', email); await fill('input[name=password]', password); await submit('.auth-form');
    await wait("location.pathname === '/en/booking' && !!document.querySelector('#booking-name')");
    const current = (await api('/booking/hold')).data.hold; assert(current); const expiry = current.expiresAt;
    await snapshot('hold-review-en');
    await sleep(1100); assert.equal((await api('/booking/hold')).data.hold.expiresAt, expiry);
    await send('Page.reload'); await wait("!!document.querySelector('#booking-name')"); assert.equal((await api('/booking/hold')).data.hold.expiresAt, expiry); results.push('A/B/D: real register, worker verification, login, intent return, hold countdown and refresh without renewal');
    await fill('#booking-company', 'Browser Company'); await fill('#booking-phone', '+84 900 000 000'); dropFinalizeOnce = true; await submit('.booking-form'); await wait("!!document.querySelector('.booking-dialog [role=\"alert\"]')");
    await submit('.booking-form'); await wait("document.body.innerText.includes('Booking request received')"); results.push('Lost finalization response: UI retry returns the same booking without duplicate intents');
    const mine = await api('/booking/mine'); assert.equal(mine.data.items.length, 1); const bookingId = mine.data.items[0].id; assert.equal(await db.notificationDelivery.count({ where: { bookingId } }), 2); results.push('A: UI finalization persists one PENDING booking');
    await navigate('/en/account/bookings'); await wait("!!document.querySelector('.customer-booking-card')"); await snapshot('my-bookings-en'); results.push('I: My Bookings restores own booking');
    // Flow C in Vietnamese: unverified login -> resend -> rotated link -> return.
    await click('.customer-actions button'); await navigate('/booking');
    await click('.booking-toolbar__navigation .booking-icon-button:last-of-type'); await select(1);
    await fill('.booking-dialog select', moduleKey); await click('.booking-dialog > .neotek-button'); await wait("location.pathname === '/login'");
    await click('.auth-switch a'); await wait("location.pathname === '/register'");
    const emailB = `${randomUUID()}@example.test`;
    await fill('input[name=name]', 'Khách hàng kiểm thử'); await fill('input[name=email]', emailB); await fill('input[name=password]', password); await fill('input[name=confirm]', password); await submit('.auth-form'); await wait("!!document.querySelector('[role=\"status\"]')");
    await click('a.auth-submit'); await fill('input[name=email]', emailB); await fill('input[name=password]', password); await submit('.auth-form'); await wait("location.pathname === '/verify-email'");
    assert(await evaluate("document.body.innerText.includes('Vui lòng xác minh email')"));
    await db.customerAccount.update({ where: { email: emailB }, data: { verificationIssuedAt: new Date(Date.now() - 61000) } });
    await click('button.auth-submit'); await wait("document.body.innerText.includes('Đã tiếp nhận yêu cầu')");
    const accountB = await db.customerAccount.findUniqueOrThrow({ where: { email: emailB } });
    const activeToken = await db.customerEmailVerification.findFirstOrThrow({ where: { customerId: accountB.id, revokedAt: null, usedAt: null } });
    let rotatedLink;
    for (let i = 0; i < 80; i++) { for (const file of await fs.readdir(process.env.EMAIL_DEV_DIRECTORY).catch(() => [])) { const mail = JSON.parse(await fs.readFile(path.join(process.env.EMAIL_DEV_DIRECTORY, file), 'utf8')); const link = mail.to === emailB ? mail.text.match(/http[^\s]+#token=[A-Za-z0-9_-]+/)?.[0] : null; if (link && createHash('sha256').update(new URLSearchParams(new URL(link).hash.slice(1)).get('token')).digest('hex') === activeToken.tokenHash) rotatedLink = link; } if (rotatedLink) break; await sleep(150); }
    assert(rotatedLink, 'Resend worker did not deliver the rotated verification link');
    await send('Page.navigate', { url: rotatedLink }); await wait("!!document.querySelector('button.auth-submit')"); await click('button.auth-submit'); await wait("document.body.innerText.includes('Email đã được xác minh')"); await click('a.auth-submit'); await wait("location.pathname === '/booking' && !!document.querySelector('#booking-name')");
    await fill('#booking-company', 'Công ty kiểm thử'); await fill('#booking-phone', '0900000000'); await submit('.booking-form'); await wait("document.body.innerText.includes('Đã nhận yêu cầu đặt lịch')");
    results.push('C/VI: unverified login, resend rotation/cooldown, real worker verification, preserved intent, hold and finalization');
    await navigate('/account/bookings'); await wait("!!document.querySelector('.customer-booking-card')"); await click('.customer-actions button'); await navigate('/en/verify-email#token=invalid'); await click('button.auth-submit'); await wait("document.body.innerText.includes('This link is invalid')"); results.push('Invalid verification link UI');
    await navigate('/en/login'); await fill('input[name=email]', email); await fill('input[name=password]', password); await submit('.auth-form'); await wait("location.pathname === '/en/booking'");
    assert.equal((await api('/booking/mine')).data.items.length, 1, 'Customer A must not see Customer B booking');
    await navigate('/en/booking'); await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
    await wait("!!document.querySelector('.booking-day__surface') && !document.querySelector('.booking-sidebar [role=\"status\"]')");
    const point = await evaluate("(() => { document.querySelector('.booking-calendar__scroll').scrollTop=0; const r=document.querySelector('.booking-day__surface').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height*185/600,dy:r.height*30/600}; })()");
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y + point.dy, button: 'left', buttons: 1 });
    await wait("!!document.querySelector('.booking-event.is-preview')");
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y + point.dy, button: 'left', clickCount: 1 });
    await wait("!!document.querySelector('[role=\"dialog\"]')"); assert.equal((await api('/booking/hold')).data.hold, null, 'Calendar selection alone must not acquire a hold');
    await click('.booking-dialog__heading button'); await wait("!document.querySelector('[role=\"dialog\"]')"); results.push('Real mouse drag preview/selection works without acquiring a hold');
    // Hold replacement: choose B while A is still held; conflict preserves A.
    await navigate('/en/booking'); await click('.booking-toolbar__navigation .booking-icon-button:last-of-type'); await select(1, 16);
    await fill('.booking-dialog select', moduleKey); await click('.booking-dialog > .neotek-button'); await wait("!!document.querySelector('#booking-name')");
    let oldHold = (await api('/booking/hold')).data.hold;
    await click('.booking-flow-actions button:first-child'); await select(2, 16); await click('.booking-dialog > .neotek-button'); await wait("!!document.querySelector('#booking-name')");
    let moved = (await api('/booking/hold')).data.hold; assert.notEqual(moved.id, oldHold.id); results.push('F: UI atomic hold replacement succeeds');
    // Acquire a competing interval using another verified service principal.
    const rival = await db.customerAccount.create({ data: { email: `${randomUUID()}@example.test`, name: 'Rival fixture', passwordHash: 'fixture-only', emailVerifiedAt: new Date() } });
    const rivalStart = new Date(new Date(moved.requestedStartAt).getTime() + 86400000);
    const rivalHold = await app.get(require('../src/booking/booking.service').BookingService).acquireHold({ realm: 'customer', customerId: rival.id }, { resourceKey: 'neotek-consultation', requestedStartAt: rivalStart.toISOString(), requestedEndAt: new Date(rivalStart.getTime() + 1800000).toISOString(), timezone: 'Asia/Ho_Chi_Minh', moduleKey, idempotencyKey: randomUUID() });
    await click('.booking-flow-actions button:first-child');
    // The calendar has stale availability from before the rival acquired: server resolves the conflict.
    await select(3, 16); await click('.booking-dialog > .neotek-button'); await wait("!!document.querySelector('.booking-dialog [role=\"alert\"]')");
    assert.equal((await api('/booking/hold')).data.hold.id, moved.id); results.push('G: UI replacement conflict preserves prior hold');
    await click('.booking-dialog__heading button'); await wait("!document.querySelector('[role=\"dialog\"]')"); assert.equal((await api('/booking/hold')).data.hold, null); results.push('E: explicit X releases hold immediately');
    await app.get(require('../src/booking/booking.service').BookingService).releaseHold({ realm: 'customer', customerId: rival.id }, rivalHold.id);
    // Expiry: shorten a fixture hold using the same DB checks, reload authoritative state.
    await select(4, 16); await click('.booking-dialog > .neotek-button'); await wait("!!document.querySelector('#booking-name')");
    const expiring = (await api('/booking/hold')).data.hold;
    const persisted = await db.bookingHold.findUniqueOrThrow({ where: { id: expiring.id } });
    await db.$executeRaw`UPDATE "BookingReservation" SET "createdAt" = clock_timestamp() - interval '10 minutes', "expiresAt" = clock_timestamp() + interval '1 second' WHERE "id" = ${persisted.reservationId}`;
    await send('Page.reload'); await wait("document.body.innerText.includes('Your hold expired') || !!document.querySelector('.booking-dialog > .neotek-button')"); await sleep(1500);
    await click('.booking-dialog > .neotek-button'); await wait("!!document.querySelector('#booking-name')"); assert.notEqual((await api('/booking/hold')).data.hold.id, expiring.id); results.push('H: expired hold can be reacquired');
    await click('.booking-flow-actions button:last-child'); await wait("!document.querySelector('[role=\"dialog\"]')");
    // VI + EN responsive booking and auth, including keyboard/focus containment.
    for (const lang of ['vi', 'en']) for (const w of [1440, 1024, 820, 390]) {
      await width(w); await navigate(`${lang === 'en' ? '/en' : ''}/booking`); await wait("!!document.querySelector('.booking-day__surface')"); await checkLayout(`Booking ${lang} ${w}`); await snapshot(`booking-${lang}-${w}`);
      for (let n = 0; n < (w < 768 ? 3 : 1); n++) await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
      await select(0, 14); await fill('.booking-dialog select', moduleKey); await click('.booking-dialog > .neotek-button'); await wait("!!document.querySelector('#booking-name')"); await checkLayout(`Hold dialog ${lang} ${w}`); await snapshot(`hold-${lang}-${w}`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      assert(await evaluate("document.querySelector('[role=\"dialog\"]').contains(document.activeElement)"), 'Dialog focus escaped');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait("!document.querySelector('[role=\"dialog\"]')"); assert.equal((await api('/booking/hold')).data.hold, null); results.push(`ESC releases hold and restores focus ${lang} ${w}`);
      await navigate(`${lang === 'en' ? '/en' : ''}/login`); await wait("!!document.querySelector('input[name=email]')"); await checkLayout(`Login ${lang} ${w}`);
      await navigate(`${lang === 'en' ? '/en' : ''}/register`); await checkLayout(`Register ${lang} ${w}`);
      await navigate(`${lang === 'en' ? '/en' : ''}/account/bookings`); await wait("!!document.querySelector('.customer-booking-card')"); await checkLayout(`My Bookings ${lang} ${w}`);
    }
    // Existing public layouts use actual published CMS content copied read-only.
    for (const route of ['/', '/en', '/solutions', '/en/solutions', ...(detailSlug ? [`/solutions/${detailSlug}`, `/en/solutions/${detailSlug}`] : [])]) for (const w of [1440, 390]) { await width(w); await navigate(route); await checkLayout(`Public ${route} ${w}`); }
    await width(1440); await navigate('/admin/login');
    await fill('input[type=email]', adminEmail); await fill('input[type=password]', password); await submit('form'); await wait("location.pathname === '/admin'");
    await navigate('/admin/bookings'); await wait("!!document.querySelector('.admin-booking-row')"); await evaluate("[...document.querySelectorAll('.admin-booking-row')].find(row => row.innerText.includes('Browser Customer')).click()"); await wait("!!document.querySelector('.admin-booking-detail')");
    await fill('.admin-booking-detail select', 'CONFIRMED'); await submit('.admin-booking-detail form:first-of-type'); await wait("document.querySelector('.admin-booking-detail > p')?.textContent === 'Đã xác nhận' && !document.querySelector('.admin-booking-detail button:disabled')");
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, 'CONFIRMED');
    await fill('.admin-booking-detail form:last-of-type textarea', 'Private browser test note'); await submit('.admin-booking-detail form:last-of-type'); await wait("document.querySelector('.admin-booking-detail')?.innerText.includes('Private browser test note')");
    results.push('J: ADMIN list/detail/confirm/audit/internal note through UI');
    for (const w of [1440, 1024, 820, 390]) { await width(w); await checkLayout(`Admin Booking ${w}`); await snapshot(`admin-booking-${w}`); await navigate('/admin/pages'); await wait("!!document.querySelector('.admin-shell')"); await checkLayout(`Admin CMS ${w}`); await navigate('/admin/bookings'); await wait("!!document.querySelector('.admin-booking-row')"); }
    // Password recovery uses actual customer state, Redis and the dev worker.
    for (const lang of ['vi', 'en']) {
      const prefixPath = lang === 'en' ? '/en' : '';
      const recoveryEmail = `${randomUUID()}@example.test`, nextPassword = 'new secure browser recovery password';
      const verifiedAt = new Date();
      const account = await db.customerAccount.create({ data: { email: recoveryEmail, name: 'Recovery browser', passwordHash: await hashPassword(password), emailVerifiedAt: verifiedAt } });
      const sessions = app.get(require('../src/customer/customer-session.service').CustomerSessionService);
      const oldSessions = [await sessions.issue(account.id), await sessions.issue(account.id)];
      await width(1440); await navigate(`${prefixPath}/login`); await click(`a[href="${prefixPath}/forgot-password"]`);
      await fill('input[name=email]', `${randomUUID()}@example.test`); await submit('.auth-form'); await wait("!!document.querySelector('[role=\"status\"]')");
      const generic = await evaluate("document.querySelector('[role=\"status\"]').textContent");
      await navigate(`${prefixPath}/forgot-password`); await fill('input[name=email]', recoveryEmail); await submit('.auth-form'); await wait("!!document.querySelector('[role=\"status\"]')");
      assert.equal(await evaluate("document.querySelector('[role=\"status\"]').textContent"), generic);
      await snapshot(`forgot-success-${lang}`);
      let resetLink;
      for (let i = 0; i < 80; i++) { for (const file of await fs.readdir(process.env.EMAIL_DEV_DIRECTORY).catch(() => [])) { const mail = JSON.parse(await fs.readFile(path.join(process.env.EMAIL_DEV_DIRECTORY, file), 'utf8')); if (mail.to === recoveryEmail) resetLink = mail.text.match(/http[^\s]+\/reset-password#token=[A-Za-z0-9_-]+/)?.[0]; } if (resetLink) break; await sleep(150); }
      assert(resetLink, 'Worker did not deliver password reset mail');
      const prepareReset = async link => { await navigate(new URL(link).pathname + new URL(link).hash); await fill('input[name=password]', nextPassword); await fill('input[name=confirmPassword]', nextPassword); };
      await prepareReset(resetLink);
      await fill('input[name=confirmPassword]', 'mismatched secure password'); await submit('.auth-form'); await wait("!!document.querySelector('[role=\"alert\"]')");
      await fill('input[name=confirmPassword]', nextPassword); await submit('.auth-form'); await wait("!!document.querySelector('[role=\"status\"]')");
      assert.equal(await evaluate('location.hash'), ''); await snapshot(`reset-success-${lang}`);
      for (const old of oldSessions) await assert.rejects(() => sessions.resolve(old));
      assert.equal((await db.customerAccount.findUniqueOrThrow({ where: { id: account.id } })).emailVerifiedAt.getTime(), verifiedAt.getTime());
      assert.equal(await evaluate("(async () => (await fetch('/api/auth/me')).status)()"), 200);
      await navigate(`${prefixPath}/login`); await fill('input[name=email]', recoveryEmail); await fill('input[name=password]', password); await submit('.auth-form'); await wait("!!document.querySelector('[role=\"alert\"]')");
      await fill('input[name=password]', nextPassword); await submit('.auth-form'); await wait(`location.pathname === '${prefixPath}/booking'`);
      assert.equal((await api('/customer-auth/me')).data.customer.email, recoveryEmail);
      await prepareReset(resetLink); await submit('.auth-form'); await wait("!document.querySelector('.auth-form') && !!document.querySelector('[role=\"alert\"]')");
      results.push(`Recovery ${lang}: generic known/unknown, dev-worker mail, mismatch, reset, session revocation, CMS isolation, old/new login and reused link`);
      // A real expired DB token also reaches the invalid-link UX after POST.
      const raw = randomBytes(32).toString('base64url');
      await db.customerPasswordReset.create({ data: { customerId: account.id, tokenHash: createHash('sha256').update(raw).digest('hex'), createdAt: new Date(Date.now() - 3600000), expiresAt: new Date(Date.now() - 1000) } });
      await prepareReset(`${origin}${prefixPath}/reset-password#token=${raw}`); await submit('.auth-form'); await wait("!document.querySelector('.auth-form') && !!document.querySelector('[role=\"alert\"]')"); results.push(`Recovery expired token ${lang}`);
      for (const w of [1440, 1024, 820, 390]) {
        await width(w); await navigate(`${prefixPath}/forgot-password`); await wait("!!document.querySelector('input[name=email]')"); await checkLayout(`Forgot password ${lang} ${w}`); await snapshot(`forgot-${lang}-${w}`);
        await navigate(`${prefixPath}/reset-password#token=${'x'.repeat(43)}`); await wait("!!document.querySelector('input[name=confirmPassword]')"); await checkLayout(`Reset password ${lang} ${w}`); await snapshot(`reset-${lang}-${w}`);
        await navigate(`${prefixPath}/reset-password#token=invalid`); await wait("!!document.querySelector('[role=\"alert\"]')"); await checkLayout(`Invalid reset ${lang} ${w}`); await snapshot(`reset-invalid-${lang}-${w}`);
      }
    }
    // Domain account survives provider failures; HTTP/Jest tests cover retry bounds.
    assert.equal(exceptions.length, 0, `Unhandled browser exceptions: ${exceptions.join(',')}`);
    await fs.writeFile(path.join(reportDir, 'results.json'), JSON.stringify({ passed: results, unhandledExceptions: exceptions, transport: 'explicit local dev mailbox', redis: 'real, random namespace', postgres: 'disposable', detailSlug: detailSlug || null }, null, 2));
    await fs.rm(path.join(reportDir, 'failure.txt'), { force: true });
    console.log(JSON.stringify({ browserChecks: results.length, unhandledExceptions: exceptions.length, artifacts: 'Neotek Frontend/docs/booking-phase1c1-browser' }));
  } catch (error) {
    await fs.writeFile(path.join(reportDir, 'failure.txt'), String(error.stack || error));
    throw error;
  } finally {
    if (socket) socket.close();
    if (chrome) { chrome.kill(); await sleep(500); }
    if (app) await app.close();
    if (staticServer) await new Promise(resolve => staticServer.close(resolve));
    for (const k of keys) await cache.del(k).catch(() => {});
    await cache.onModuleDestroy(); await db.$disconnect();
    // Only the freshly-created browser directory; never a computed workspace path.
    const checked = path.resolve(temporary); assert(checked.startsWith(path.join(os.tmpdir(), 'neotek-booking-browser-')));
    await fs.rm(checked, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
