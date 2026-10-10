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
  const reportDir = path.join(frontend, 'docs/booking-phase2c-browser');
  const frontendEnv = dotenv.parse(await fs.readFile(path.join(frontend, '.env.local')));
  const googleClientId = frontendEnv.VITE_GOOGLE_CLIENT_ID;
  assert(googleClientId && frontendEnv.VITE_FEATURE_GOOGLE_LOGIN === 'true', 'Build frontend with Google fixture or configured public client ID');
  let gisMode = 'success', googleConfigAbsent = false;
  const googleFixtures = new Map();
  await fs.mkdir(reportDir, { recursive: true });
  for (const name of ['hold-review-en', 'google-login-vi-390', 'google-register-en-1440', 'google-register-en-390']) {
    const target = path.join(reportDir, `before-${name}.png`);
    try { await fs.access(target); } catch { await fs.copyFile(path.join(frontend, `docs/booking-phase2b1-ui-recovery-browser/${name}.png`), target).catch(() => {}); }
  }
  process.env.NODE_ENV = 'development'; process.env.DATABASE_URL = url.href;
  process.env.REDIS_URL = local.REDIS_URL;
  process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.BOOKING_ADMIN_EMAIL = 'booking-admin@example.test';
  process.env.EMAIL_PROVIDER = 'dev'; process.env.EMAIL_DEV_DIRECTORY = path.join(temporary, 'mail');
  process.env.BOOKING_LEAD_MINUTES = '0';
  process.env.GOOGLE_CUSTOMER_LOGIN_ENABLED = 'true'; process.env.GOOGLE_CUSTOMER_CLIENT_ID = googleClientId;
  process.env.GOOGLE_CALENDAR_ENABLED = 'true';
  process.env.GOOGLE_CALENDAR_CLIENT_ID = 'calendar-browser-fixture';
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = 'calendar-fixture-secret';
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost:3000/api/integrations/google/calendar/callback';
  process.env.GOOGLE_CALENDAR_ORGANIZER_EMAIL = 'organizer@example.test';
  process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  require('ts-node/register');
  const { GoogleCalendarClient } = require('../src/booking/google-calendar.client');
  const { VerificationSecret } = require('../src/notification/verification-secret');
  let meetCalls = 0, failMeet = true;
  const calendarClient = { exchange: async () => ({ refreshToken: 'mock-refresh', email: 'organizer@example.test' }), createMeeting: async () => { meetCalls++; if (failMeet) throw new (require('@nestjs/common').ServiceUnavailableException)('Google unavailable'); return 'https://meet.google.com/abc-defg-hij'; }, deleteEvent: async () => { throw new Error('mock deletion failure'); } };
  const { Test } = require('@nestjs/testing');
  const { PrismaClient } = require('@prisma/client');
  const { AppModule } = require('../src/app.module');
  const { CacheService } = require('../src/cache/cache.service');
  const { PrismaService } = require('../src/prisma/prisma.service');
  const { configureHttpSecurity } = require('../src/config/http-security');
  const { hashPassword } = require('../src/auth/password.util');
  const { GoogleTokenVerifier } = require('../src/customer/google-token-verifier');
  const { UnauthorizedException } = require('@nestjs/common');
  const db = new PrismaClient();
  const cache = new CacheService();
  const prefix = `booking-browser:${randomUUID()}:`, keys = new Set();
  const key = value => { const k = prefix + value; keys.add(k); return k; };
  const scopedCache = {
    consume: k => cache.consume(key(k)), get: k => cache.get(key(k)), set: (k, v, ttl) => cache.set(key(k), v, ttl), del: k => cache.del(key(k)), ping: () => cache.ping(),
    incrementWithExpiry: (k, ttl) => cache.incrementWithExpiry(key(k), ttl),
    getOrCreateSessionToken: (s, c, v) => cache.getOrCreateSessionToken(key(s), key(c), v),
  };
  let app, chrome, staticServer, socket;
  const results = [], exceptions = [];
  try {
    await db.$connect();
    const organizerFixture = { id: 'google-calendar-organizer', email: process.env.GOOGLE_CALENDAR_ORGANIZER_EMAIL, clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID, encryptedRefreshToken: new VerificationSecret(process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY).seal('mock-refresh', 'google-calendar-organizer') };
    await db.organizerCredential.upsert({ where: { id: organizerFixture.id }, create: organizerFixture, update: organizerFixture });
    await cache.onModuleInit(); assert.equal(await cache.ping(), 'PONG');
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
        res.setHeader('Cache-Control', 'no-store');
        const content = await fs.readFile(filename);
        res.end(googleConfigAbsent && path.extname(filename) === '.js' ? content.toString().replaceAll(googleClientId, '') : content);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${staticServer.address().port}`;
    process.env.FRONTEND_URL = origin;
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(GoogleCalendarClient).useValue(calendarClient).overrideProvider(CacheService).useValue(scopedCache).overrideProvider(PrismaService).useValue(db).overrideProvider(GoogleTokenVerifier).useValue({ verify: async credential => { const identity = googleFixtures.get(credential); if (!identity) throw new UnauthorizedException('Google login could not be completed'); return identity; } }).compile();
    app = module.createNestApplication({ bodyParser: false, logger: false }); configureHttpSecurity(app); await app.listen(0, '127.0.0.1'); backendPort = app.getHttpServer().address().port;
    // Reserve an ephemeral debugging port, then let Chrome own it.
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const debugPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-features=Translate', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(temporary, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let target;
    for (let i = 0; i < 100; i++) { try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch {} await sleep(100); }
    assert(target, 'Chrome did not start');
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let nextId = 0, handleGIS; const callbacks = new Map();
    socket.onmessage = event => { const value = JSON.parse(event.data); if (value.id) { const cb = callbacks.get(value.id); if (cb) { callbacks.delete(value.id); clearTimeout(cb.timer); value.error ? cb.reject(new Error(value.error.message)) : cb.resolve(value.result); } } else if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails.text); else if (value.method === 'Fetch.requestPaused') handleGIS(value.params).catch(error => exceptions.push(error.message)); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => { callbacks.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000); callbacks.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    handleGIS = async ({ requestId, request }) => {
      if (request.url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')) {
        const params = new URL(request.url).searchParams;
        assert.equal(params.get('access_type'), 'offline');
        assert.equal(params.get('client_id'), process.env.GOOGLE_CALENDAR_CLIENT_ID);
        assert.equal(params.get('redirect_uri'), process.env.GOOGLE_CALENDAR_REDIRECT_URI);
        return send('Fetch.fulfillRequest', { requestId, responseCode: 302, responseHeaders: [{ name: 'Location', value: origin + '/api/integrations/google/calendar/callback?code=mock-code&state=' + encodeURIComponent(params.get('state')) }], body: '' });
      }
      if (gisMode === 'failure') return send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      const script = `window.__gisInitializations=0;window.google={accounts:{id:{initialize(options){window.__gisInitializations++;this.options=options},renderButton(element,options){const button=document.createElement('button');button.type='button';button.className='gis-fixture';button.textContent=options.locale==='en'?'Continue with Google':'Tiếp tục với Google';button.onclick=()=>this.options.callback({credential:window.__googleCredential||'fixture.rejectedcredential.signature',state:options.state});element.replaceChildren(button)},disableAutoSelect(){window.__googleSignedOut=true}}}};`;
      return send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript' }], body: Buffer.from(script).toString('base64') });
    };
    await send('Fetch.enable', { patterns: [{ urlPattern: 'https://accounts.google.com/gsi/client*', requestStage: 'Request' }, { urlPattern: 'https://accounts.google.com/o/oauth2/v2/auth*', requestStage: 'Request' }] });
    const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; };
    const wait = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(100); } throw new Error(`Browser wait failed: ${expression}; text=${await evaluate('document.body.innerText.slice(-1800)')}`); };
    const navigate = async route => { await send('Page.navigate', { url: origin + route }); await wait("document.readyState === 'complete' && !!document.querySelector('h1')"); };
    const googleRequests = [];
    const click = async selector => {
      await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
      // Keep the production 10/minute Google IP guard enabled; space fixture callbacks across languages.
      if (selector === '.gis-fixture') {
        while (googleRequests.length && Date.now() - googleRequests[0] >= 61000) googleRequests.shift();
        if (googleRequests.length >= 9) { await sleep(Math.max(1, 61000 - Date.now() + googleRequests[0])); while (googleRequests.length && Date.now() - googleRequests[0] >= 61000) googleRequests.shift(); }
        googleRequests.push(Date.now());
      }
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(150);
      if (selector === '.booking-form__submit') await wait("!document.querySelector('.booking-form__submit:disabled')");
    };
    const fill = async (selector, value) => { await wait(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!input) return false; const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : input.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`); };
    const submit = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`); await sleep(200); };
    const api = async (route, method = 'GET', body) => evaluate(`(async () => { const method=${JSON.stringify(method)}; const headers={}; if(method!=='GET'){ const csrf=await (await fetch('/api/customer-auth/csrf')).json();headers['x-csrf-token']=csrf.csrfToken;headers['Content-Type']='application/json'; } const response=await fetch('/api'+${JSON.stringify(route)},{method,headers,${body === undefined ? '' : `body:JSON.stringify(${JSON.stringify(body)}),`}credentials:'include'});return {status:response.status,data:await response.json()}; })()`);
    const width = async value => send('Emulation.setDeviceMetricsOverride', { width: value, height: 1000, deviceScaleFactor: 1, mobile: value < 768 });
    const snapshot = async name => { const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await fs.writeFile(path.join(reportDir, `${name}.png`), Buffer.from(shot.data, 'base64')); };
    const checkLayout = async label => { await sleep(300); assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), `Horizontal overflow: ${label}`); results.push(label); };
    const key = async key => { const code = key === ' ' ? 'Space' : key; await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }); await sleep(70); };
    const chooseModule = async () => {
      await wait("!!document.querySelector('#booking-module:not(:disabled)') && !document.querySelector('.booking-calendar-status[role=status]')");
      await evaluate("document.querySelector('#booking-module').focus()"); await key('ArrowDown'); await wait("!!document.querySelector('[role=option]')"); await key('Home'); await key('Enter'); await wait("!document.querySelector('[role=listbox]') && !document.querySelector('#booking-module[data-placeholder]')");
    };
    const selectRadix = async (selector, optionKey) => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await key('ArrowDown'); await wait("!!document.querySelector('[role=option]')"); await key(optionKey); await key('Enter'); await wait("!document.querySelector('[role=listbox]')"); };
    const activateTab = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await key('Enter'); };
    const accountMenu = async w => {
      const trigger = w < 1024 ? '.neotek-navbar__mobile-footer .neotek-navbar__account' : '.neotek-navbar__actions .neotek-navbar__account';
      if (w < 1024) { await click('.neotek-navbar__menu-button'); await wait("!!document.querySelector('.neotek-navbar__dialog')"); }
      await wait(`!!document.querySelector(${JSON.stringify(trigger)})`); await evaluate(`document.querySelector(${JSON.stringify(trigger)}).focus()`); await key('ArrowDown');
      await wait("!!document.querySelector('.neotek-account-menu') && document.activeElement.getAttribute('role')==='menuitem'");
      assert.equal(await evaluate("document.querySelectorAll('.neotek-account-menu [role=menuitem]').length"), 2);
      return trigger;
    };
    const logoutMenu = async () => { await accountMenu(await evaluate('window.innerWidth')); await key('End'); await key('Enter'); await wait("!document.querySelector('.neotek-navbar__account')"); assert.equal((await api('/customer-auth/me')).status, 401); };
    const select = async (column = 0, offset = 12, choose = true) => {
      await wait("!!document.querySelector('.booking-day__surface') && !document.querySelector('.booking-calendar-status[role=\"status\"]')");
      await evaluate(`document.querySelectorAll('.booking-day__surface')[${column}].focus()`);
      for (const key of ['Home', ...Array(offset).fill('ArrowDown'), 'Enter']) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Home' ? 36 : 40 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }); await sleep(60); }
      await wait("!!document.querySelector('[role=\"dialog\"]')");
      if (choose) await chooseModule();
    };
    // Flow A: anonymous local selection -> registration -> verification -> hold.
    await width(1440); await navigate('/en/booking');
    await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
    await select(0, 12, false);
    const moduleKey = (await api('/booking/options')).data.modules[0].key;
    assert.equal(await evaluate("document.querySelectorAll('.booking-dialog [role=combobox]').length"), 1); assert.equal(await evaluate("!!document.querySelector('.booking-sidebar [role=combobox]')"), false);
    assert.equal((await api('/booking/hold')).status, 401);
    await click('.booking-form__submit'); await wait("document.activeElement.id==='booking-module' && !!document.querySelector('.booking-dialog [role=alert]')"); await chooseModule(); results.push('Direct slot opens modal without solution pre-step; required Radix solution and no anonymous hold');
    await click('.booking-form__submit');
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
    await wait("!!document.querySelector('.booking-form__submit')"); await click('.booking-form__submit'); await wait("location.pathname === '/en/login'"); await fill('input[name=email]', email); await fill('input[name=password]', password); await submit('.auth-form');
    await wait("location.pathname === '/en/booking' && !!document.querySelector('.booking-hold-status')");
    const current = (await api('/booking/hold')).data.hold; assert(current); const expiry = current.expiresAt;
    await snapshot('hold-review-en');
    await sleep(1100); assert.equal((await api('/booking/hold')).data.hold.expiresAt, expiry);
    await send('Page.reload'); await wait("!!document.querySelector('.booking-hold-status')"); assert.equal((await api('/booking/hold')).data.hold.expiresAt, expiry); results.push('A/B/D: real register, worker verification, login, intent return, hold countdown and refresh without renewal');
    await fill('#booking-company', 'Browser Company'); await fill('#booking-phone', '+84 900 000 000'); dropFinalizeOnce = true; await submit('.booking-form'); await wait("!!document.querySelector('.booking-dialog [role=\"alert\"]')");
    await submit('.booking-form'); await wait("document.body.innerText.includes('Booking request received')"); results.push('Lost finalization response: UI retry returns the same booking without duplicate intents');
    const mine = await api('/booking/mine'); assert.equal(mine.data.items.length, 1); const bookingId = mine.data.items[0].id; assert.equal(await db.notificationDelivery.count({ where: { bookingId } }), 2); results.push('A: UI finalization persists one PENDING booking');
    await navigate('/en/account/bookings'); await wait("!!document.querySelector('.customer-booking-card')"); await snapshot('my-bookings-en'); results.push('I: My Bookings restores own booking');
    // Flow C in Vietnamese: unverified login -> resend -> rotated link -> return.
    await logoutMenu(); await navigate('/booking');
    assert.equal(await evaluate("!!document.querySelector('.booking-event--own')"), false);
    await click('.booking-toolbar__navigation .booking-icon-button:last-of-type'); await select(1);
    await click('.booking-form__submit'); await wait("location.pathname === '/login'");
    await click('.auth-switch a'); await wait("location.pathname === '/register'");
    const emailB = `${randomUUID()}@example.test`;
    await fill('input[name=name]', 'Khách hàng kiểm thử'); await fill('input[name=email]', emailB); await fill('input[name=password]', password); await fill('input[name=confirm]', password); await submit('.auth-form'); await wait("!!document.querySelector('[role=\"status\"]')");
    await click('a.auth-submit'); await fill('input[name=email]', emailB); await fill('input[name=password]', password); await submit('.auth-form'); await wait("location.pathname === '/verify-email'");
    await wait("document.body.innerText.includes('Vui lòng xác minh email')");
    await db.customerAccount.update({ where: { email: emailB }, data: { verificationIssuedAt: new Date(Date.now() - 61000) } });
    await click('button.auth-submit'); await wait("document.body.innerText.includes('Đã tiếp nhận yêu cầu')");
    const accountB = await db.customerAccount.findUniqueOrThrow({ where: { email: emailB } });
    const activeToken = await db.customerEmailVerification.findFirstOrThrow({ where: { customerId: accountB.id, revokedAt: null, usedAt: null } });
    let rotatedLink;
    for (let i = 0; i < 80; i++) { for (const file of await fs.readdir(process.env.EMAIL_DEV_DIRECTORY).catch(() => [])) { const mail = JSON.parse(await fs.readFile(path.join(process.env.EMAIL_DEV_DIRECTORY, file), 'utf8')); const link = mail.to === emailB ? mail.text.match(/http[^\s]+#token=[A-Za-z0-9_-]+/)?.[0] : null; if (link && createHash('sha256').update(new URLSearchParams(new URL(link).hash.slice(1)).get('token')).digest('hex') === activeToken.tokenHash) rotatedLink = link; } if (rotatedLink) break; await sleep(150); }
    assert(rotatedLink, 'Resend worker did not deliver the rotated verification link');
    await send('Page.navigate', { url: rotatedLink }); await wait("!!document.querySelector('button.auth-submit')"); await click('button.auth-submit'); await wait("document.body.innerText.includes('Email đã được xác minh')"); await click('a.auth-submit'); await wait("location.pathname === '/booking' && !!document.querySelector('.booking-hold-status')");
    await fill('#booking-company', 'Công ty kiểm thử'); await fill('#booking-phone', '0900000000'); await submit('.booking-form'); await wait("document.body.innerText.includes('Đã nhận yêu cầu đặt lịch')");
    results.push('C/VI: unverified login, resend rotation/cooldown, real worker verification, preserved intent, hold and finalization');
    await navigate('/account/bookings'); await wait("!!document.querySelector('.customer-booking-card')"); await logoutMenu(); await navigate('/en/verify-email#token=invalid'); await click('button.auth-submit'); await wait("document.body.innerText.includes('This link is invalid')"); results.push('Invalid verification link UI');
    await navigate('/en/login'); await fill('input[name=email]', email); await fill('input[name=password]', password); await submit('.auth-form'); await wait("location.pathname === '/en/booking'");
    assert.equal((await api('/booking/mine')).data.items.length, 1, 'Customer A must not see Customer B booking');
    await navigate('/en/booking'); await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
    await wait("!!document.querySelector('.booking-day__surface') && !document.querySelector('.booking-calendar-status[role=\"status\"]')");
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
    await click('.booking-form__submit'); await wait("!!document.querySelector('.booking-hold-status')");
    let oldHold = (await api('/booking/hold')).data.hold;
    await click('.booking-change-time'); await select(2, 16); await click('.booking-form__submit'); await wait("!!document.querySelector('.booking-hold-status')");
    let moved = (await api('/booking/hold')).data.hold; assert.notEqual(moved.id, oldHold.id); results.push('F: UI atomic hold replacement succeeds');
    await wait("!document.querySelector('.booking-calendar-status[role=status]')");
    // Acquire a competing interval using another verified service principal.
    const rival = await db.customerAccount.create({ data: { email: `${randomUUID()}@example.test`, name: 'Rival fixture', passwordHash: 'fixture-only', emailVerifiedAt: new Date() } });
    const rivalStart = new Date(new Date(moved.requestedStartAt).getTime() + 86400000);
    const rivalHold = await app.get(require('../src/booking/booking.service').BookingService).acquireHold({ realm: 'customer', customerId: rival.id }, { resourceKey: 'neotek-consultation', requestedStartAt: rivalStart.toISOString(), requestedEndAt: new Date(rivalStart.getTime() + 1800000).toISOString(), timezone: 'Asia/Ho_Chi_Minh', moduleKey, idempotencyKey: randomUUID() });
    await click('.booking-change-time');
    // The calendar has stale availability from before the rival acquired: server resolves the conflict.
    await select(3, 16); await click('.booking-form__submit'); await wait("!!document.querySelector('.booking-dialog [role=\"alert\"]')");
    assert.equal((await api('/booking/hold')).data.hold.id, moved.id); results.push('G: UI replacement conflict preserves prior hold');
    await click('.booking-dialog__heading button'); await wait("!document.querySelector('[role=\"dialog\"]')"); assert.equal((await api('/booking/hold')).data.hold, null); results.push('E: explicit X releases hold immediately');
    await app.get(require('../src/booking/booking.service').BookingService).releaseHold({ realm: 'customer', customerId: rival.id }, rivalHold.id);
    // Expiry: shorten a fixture hold using the same DB checks, reload authoritative state.
    await select(4, 16); await click('.booking-form__submit'); await wait("!!document.querySelector('.booking-hold-status')");
    const expiring = (await api('/booking/hold')).data.hold;
    const persisted = await db.bookingHold.findUniqueOrThrow({ where: { id: expiring.id } });
    await db.$executeRaw`UPDATE "BookingReservation" SET "createdAt" = clock_timestamp() - interval '10 minutes', "expiresAt" = clock_timestamp() + interval '1 second' WHERE "id" = ${persisted.reservationId}`;
    await send('Page.reload'); await wait("document.body.innerText.includes('Your hold expired') || !!document.querySelector('.booking-form__submit')"); await sleep(1500);
    await click('.booking-form__submit'); await wait("!!document.querySelector('.booking-hold-status')"); assert.notEqual((await api('/booking/hold')).data.hold.id, expiring.id); results.push('H: expired hold can be reacquired');
    await click('.booking-dialog__heading button'); await wait("!document.querySelector('[role=\"dialog\"]')");
    // VI + EN responsive booking and auth, including keyboard/focus containment.
    for (const lang of ['vi', 'en']) for (const w of [1440, 1280, 1024, 820, 390]) {
      await width(w); await navigate(`${lang === 'en' ? '/en' : ''}/booking`); await wait("!!document.querySelector('.booking-day__surface')");
      for (let n = 0; n < (w < 768 ? 3 : 1); n++) await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
      await wait("!document.querySelector('.booking-calendar-status[role=status]')");
      assert.equal(await evaluate("document.querySelector('.booking-sidebar').children.length"), 3);
      assert.equal(await evaluate("document.querySelector('.booking-calendar__scroll').scrollHeight > document.querySelector('.booking-calendar__scroll').clientHeight"), false);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.booking-workspace__body')).gridTemplateColumns.split(' ').length"), w < 768 ? 1 : 2);
      assert.equal(await evaluate("document.querySelector('.booking-sidebar').contains(document.querySelector('.booking-duration'))"), true);
      assert(await evaluate("[...document.querySelectorAll('.booking-duration label')].every(label=>label.getBoundingClientRect().right<=document.querySelector('.booking-sidebar').getBoundingClientRect().right)"), 'Duration controls overflow support column');
      await checkLayout(`Booking ${lang} ${w}`); await snapshot(`booking-${lang}-${w}`);
      results.push(`Exactly three support sections, adaptive grid and native page scroll ${lang} ${w}`);
      await select(0, 14); assert.equal((await api('/booking/hold')).data.hold, null); await click('.booking-form__submit'); await wait("!!document.querySelector('.booking-hold-status')"); await checkLayout(`Hold dialog ${lang} ${w}`); await snapshot(`hold-${lang}-${w}`);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.booking-form')).gridTemplateColumns.split(' ').length"), w < 600 ? 1 : 2);
      assert.equal(await evaluate("document.querySelectorAll('.booking-flow-actions .neotek-button').length"), 1);
      assert.equal(await evaluate("document.querySelectorAll('.booking-dialog [role=combobox]').length"), 1);
      assert.equal(await evaluate("!!document.querySelector('.booking-sidebar [role=combobox]')"), false);
      assert(await evaluate("document.querySelector('#booking-module').textContent.length > 0"));
      results.push(`Compact modal grid, one solution control, primary booking action and server hold ${lang} ${w}`);
      if (w === 390) {
        await send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
        await evaluate("document.querySelector('.booking-flow-actions .neotek-button').focus()");
        assert(await evaluate("(() => {const r=document.querySelector('.booking-dialog').getBoundingClientRect(); const b=document.activeElement.getBoundingClientRect(); return r.top>=0 && r.bottom<=844 && b.bottom<=844 && b.top>=0})()"), 'Mobile modal actions unreachable');
        await snapshot(`hold-${lang}-390-844`); results.push(`Mobile modal scrolling and reachable actions ${lang} 390x844`); await width(w);
      }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      assert(await evaluate("document.querySelector('[role=\"dialog\"]').contains(document.activeElement)"), 'Dialog focus escaped');
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await wait("!document.querySelector('[role=\"dialog\"]')"); assert.equal((await api('/booking/hold')).data.hold, null); results.push(`ESC releases hold and restores focus ${lang} ${w}`);
      await navigate(`${lang === 'en' ? '/en' : ''}/login`); await wait(`location.pathname==='${lang === 'en' ? '/en' : ''}/booking'`); results.push(`Authenticated Login redirect ${lang} ${w}`);
      await navigate(`${lang === 'en' ? '/en' : ''}/register`); await wait(`location.pathname==='${lang === 'en' ? '/en' : ''}/booking'`); results.push(`Authenticated Register redirect ${lang} ${w}`);
      await click('.booking-view-tabs button:first-child'); await wait("!!document.querySelector('.booking-month__grid')"); await checkLayout(`Month view ${lang} ${w}`); await snapshot(`month-${lang}-${w}`);
      await click('.booking-month__day:not(.is-muted)'); await wait("!!document.querySelector('.booking-day__surface')");
      await navigate(`${lang === 'en' ? '/en' : ''}/account/bookings`); await wait("!!document.querySelector('.customer-booking-card')"); await checkLayout(`My Bookings ${lang} ${w}`); await snapshot(`my-bookings-${lang}-${w}`);
      assert.equal(await evaluate("!!document.querySelector('.auth-page, .customer-actions')"), false);
      assert(await evaluate("!!document.querySelector('.customer-booking-status') && !!document.querySelector('.customer-booking-meeting') && !!document.querySelector('.neotek-navbar')"));
      await activateTab('.customer-bookings-tabs button:last-child'); await wait("!document.querySelector('.customer-booking-card') && !!document.querySelector('.customer-bookings-state h2')");
      await snapshot(`my-bookings-past-${lang}-${w}`);
      await activateTab('.customer-bookings-tabs button:first-child'); await wait("!!document.querySelector('.customer-booking-card')");
      results.push(`Account layout, upcoming/past filters, empty state and navbar logout ownership ${lang} ${w}`);
    }
    const ownDate = new Date(new Date(mine.data.items[0].requestedStartAt).getTime() + 7 * 3600000).toISOString().slice(0, 10);
    for (const lang of ['vi', 'en']) for (const w of [1440, 1280, 1024, 820, 390]) {
      await width(w); await navigate(`${lang === 'en' ? '/en' : ''}/booking`);
      if (!await evaluate("document.querySelector('.booking-sidebar__calendar').open")) await click('.booking-sidebar__calendar summary');
      await click(`.booking-mini__date[data-date="${ownDate}"]`); await wait("!!document.querySelector('.booking-event--own')");
      const event = await evaluate("document.querySelector('.booking-event--own').innerText");
      assert(event.includes(mine.data.items[0].solution)); assert(!event.includes('Browser Customer') && !event.includes('Browser Company') && !event.includes(email));
      assert.equal(await evaluate("!!document.querySelector('.neotek-navbar__cta, .neotek-navbar__login')"), false);
      if (w < 768) { await click('.booking-sidebar__calendar summary'); await evaluate("document.querySelector('.booking-event--own').focus()"); }
      await checkLayout(`Own booking and authenticated navbar ${lang} ${w}`); await snapshot(`own-booking-${lang}-${w}`);
      results.push(`Owner overlay shows solution/time/status without PII and leaves availability separate ${lang} ${w}`);
    }
    // Existing public layouts use actual published CMS content copied read-only.
    for (const route of ['/', '/en', '/solutions', '/en/solutions', ...(detailSlug ? [`/solutions/${detailSlug}`, `/en/solutions/${detailSlug}`] : [])]) for (const w of [1440, 390]) { await width(w); await navigate(route); await checkLayout(`Public ${route} ${w}`); }
    await width(1440); await navigate('/admin/login');
    await fill('input[type=email]', adminEmail); await fill('input[type=password]', password); await submit('form'); await wait("location.pathname === '/admin'");
    await wait("!!document.querySelector('.admin-tutorial-close')"); await click('.admin-tutorial-close'); await wait("!document.querySelector('.admin-tutorial-panel')");
    await navigate('/admin/bookings'); await wait("!!document.querySelector('.admin-calendar-connection button:not(:disabled)')");
    await click('.admin-calendar-connection button');
    await wait("location.pathname === '/admin/bookings' && !!document.querySelector('.admin-booking-row') && document.querySelector('.admin-calendar-connection')?.textContent.includes('organizer@example.test')");
    results.push('Phase 2C ADMIN organizer reconnect via real session, Origin, CSRF, Redis state, backend callback and encrypted persistence; Google authorization/exchange mocked');
    await evaluate("[...document.querySelectorAll('.admin-booking-row')].find(row => row.innerText.includes('Browser Customer')).click()"); await wait("!!document.querySelector('.admin-booking-detail')");
    assert(await evaluate("document.querySelector('[data-action=confirm]').disabled"));
    await fill('.admin-booking-transition input[name=meetingUrl]', 'https://evil.test/abc-defg-hij'); assert(await evaluate("document.querySelector('[data-action=confirm]').disabled"));
    await fill('.admin-booking-transition input[name=meetingUrl]', 'https://meet.google.com/abc-defg-hij'); assert.equal(await evaluate("document.querySelector('[data-action=confirm]').disabled"), false);
    await fill('.admin-booking-transition input[name=meetingUrl]', '');
    await click('[data-action=generate-meet]'); await wait("!!document.querySelector('.admin-alert--error')");
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, 'PENDING');
    assert.equal(await evaluate("!!document.querySelector('.admin-booking-transition input[name=meetingUrl]')"), true);
    failMeet = false;
    await click('[data-action=generate-meet]'); await wait("document.querySelector('.admin-booking-transition input[name=meetingUrl]')?.value === 'https://meet.google.com/abc-defg-hij'");
    assert.equal(meetCalls, 2);
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, 'PENDING');
    assert.equal(await evaluate("!!document.querySelector('[data-action=generate-meet]')"), false);
    results.push('Phase 2C Google provider failure preserves manual fallback; retry saves Meet while PENDING; explicit confirmation remains required');
    await snapshot('admin-pending-meet'); await click('[data-action=confirm]'); await wait("!!document.querySelector('.admin-booking-detail .admin-booking-status--CONFIRMED') && !!document.querySelector('[data-action=complete]')");
    assert(await evaluate("document.querySelector('[data-action=complete]').disabled"));
    assert.equal(await evaluate("!!document.querySelector('.admin-booking-transition input, .admin-booking-transition [role=combobox]')"), false);
    assert.equal((await api('/booking/mine')).data.items[0].meetingUrl, 'https://meet.google.com/abc-defg-hij');
    assert.equal((await db.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, 'CONFIRMED');
    await fill('.admin-booking-note-form textarea', 'Private browser test note'); await submit('.admin-booking-note-form'); await wait("document.querySelector('.admin-booking-detail')?.innerText.includes('Private browser test note')");
    results.push('J: ADMIN list/detail/confirm/audit/internal note through UI');
    for (const lang of ['vi', 'en']) for (const w of [1440, 1280, 1024, 820, 390]) {
      await width(w); await navigate(`${lang === 'en' ? '/en' : ''}/account/bookings`); await wait("!!document.querySelector('.customer-booking-meeting a')");
      assert.equal(await evaluate("document.querySelector('.customer-booking-meeting a').href"), 'https://meet.google.com/abc-defg-hij');
      assert((await evaluate("document.querySelector('.customer-booking-meeting').innerText")).includes('Google Meet'));
      await checkLayout(`Confirmed My Bookings Meet ${lang} ${w}`); await snapshot(`my-bookings-meet-${lang}-${w}`);
    }
    await width(1440); await navigate('/admin/bookings'); await wait("!!document.querySelector('.admin-booking-row')");
    for (const w of [1440, 1280, 1024, 820, 390]) {
      await width(w);
      if (!await evaluate("!!document.querySelector('.admin-booking-detail')")) { await evaluate("[...document.querySelectorAll('.admin-booking-row')].find(row => row.innerText.includes('Browser Customer')).click()"); await wait("!!document.querySelector('.admin-booking-detail')"); }
      await evaluate("document.querySelector('.admin-main').scrollTop=0");
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.admin-booking-columns')).gridTemplateColumns.split(' ').length"), w <= 820 ? 1 : 2);
      assert.equal(await evaluate("!!document.querySelector('.admin-bookings select:not([aria-hidden=true])')"), false);
      assert(await evaluate("document.querySelector('.admin-bookings').scrollWidth<=document.querySelector('.admin-bookings').clientWidth+1"), `Admin booking content overflow ${w}`);
      assert(await evaluate("document.querySelector('.admin-header').getBoundingClientRect().top >= -1"), `Admin shell displaced ${w}`);
      assert(await evaluate("parseFloat(getComputedStyle(document.querySelector('.admin-booking-search input')).paddingLeft)>=40"), 'Search icon overlaps input text');
      await checkLayout(`Admin Booking ${w}`); await snapshot(`admin-booking-${w}`);
      if (w <= 820) {
        await click('.admin-booking-row[aria-pressed=true]'); await wait("!!document.querySelector('.admin-booking-detail') && document.activeElement===document.querySelector('.admin-booking-detail')");
        assert(await evaluate("document.querySelector('.admin-header').getBoundingClientRect().top >= -1"), 'Mobile detail scroll displaced shell');
        assert(await evaluate("document.querySelector('.admin-booking-detail').getBoundingClientRect().top>=document.querySelector('.admin-main').getBoundingClientRect().top-1"), 'Detail not visible inside CMS content');
        await snapshot(`admin-booking-detail-${w}`);
      }
      results.push(`Admin list/detail, compact Radix filters and accessible details ${w}`);
      await navigate('/admin/pages'); await wait("!!document.querySelector('.admin-shell')"); await checkLayout(`Admin CMS ${w}`);
      await navigate('/admin/bookings'); await wait("!!document.querySelector('.admin-booking-row')");
    }
    await width(1440); await fill('.admin-booking-filters input[name=search]', 'Browser Company'); await submit('.admin-booking-filters'); await wait("!!document.querySelector('.admin-booking-row')");
    assert.equal(await evaluate("document.querySelectorAll('.admin-booking-row').length"), 1);
    await click('.admin-booking-filters button[type=reset]'); await wait("document.querySelectorAll('.admin-booking-row').length===2");
    await selectRadix('.admin-booking-filters .admin-select-trigger', 'End'); await submit('.admin-booking-filters'); await wait("!!document.querySelector('.admin-booking-placeholder') && !document.querySelector('.admin-booking-row')");
    await click('.admin-booking-filters button[type=reset]'); await wait("document.querySelectorAll('.admin-booking-row').length===2");
    await fill('.admin-booking-filters input[name=to]', '2020-01-01'); await submit('.admin-booking-filters'); await wait("!!document.querySelector('.admin-booking-placeholder') && !document.querySelector('.admin-booking-row')");
    await click('.admin-booking-filters button[type=reset]'); await wait("document.querySelectorAll('.admin-booking-row').length===2");
    results.push('Admin status and date filters reach server and reset to the complete list');
    await evaluate("[...document.querySelectorAll('.admin-booking-row')].find(row => row.innerText.includes('Khách hàng kiểm thử')).click()"); await wait("!!document.querySelector('.admin-booking-transition')");
    await click('[data-action=start-cancel]'); await submit('.admin-booking-transition');
    assert.equal((await db.booking.findFirstOrThrow({ where:{ customerId:accountB.id } })).status, 'PENDING');
    await fill('.admin-booking-transition textarea', 'Customer requested cancellation'); await submit('.admin-booking-transition'); await wait("!!document.querySelector('[role=alertdialog]')"); await click('.admin-confirm-content .admin-button--primary'); await wait("!!document.querySelector('.admin-booking-detail .admin-booking-status--CANCELLED')");
    assert.equal((await db.booking.findFirstOrThrow({ where:{ customerId:accountB.id } })).status, 'CANCELLED');
    assert.equal(await evaluate("!!document.querySelector('.admin-booking-transition [data-action]')"), false); await snapshot('admin-cancelled-terminal');
    const completedBooking = await db.booking.findUniqueOrThrow({ where:{ id:bookingId } });
    const pastStart = new Date(Date.now() - 7200000), pastEnd = new Date(Date.now() - 3600000);
    await db.bookingReservation.update({ where:{ id:completedBooking.reservationId }, data:{ requestedStartAt:pastStart, requestedEndAt:pastEnd, busyStartAt:pastStart, busyEndAt:pastEnd } });
    await evaluate("[...document.querySelectorAll('.admin-booking-row')].find(row => row.innerText.includes('Browser Customer')).click()"); await wait("!!document.querySelector('[data-action=complete]:not(:disabled)')"); await click('[data-action=complete]'); await wait("!!document.querySelector('.admin-booking-status--COMPLETED') && !document.querySelector('.admin-booking-transition [data-action]')"); assert((await evaluate("document.querySelector('.admin-booking-status--COMPLETED').textContent")).includes('Hoàn thành')); await snapshot('admin-completed-terminal');
    results.push('Admin pending/confirmed actions, Meet validation, reason plus Radix cancellation confirmation and terminal states');
    const confirmation = await db.notificationDelivery.findFirstOrThrow({ where:{ bookingId, template:'BOOKING_CONFIRMED_CUSTOMER' } });
    assert.equal(confirmation.payload.meetingUrl, 'https://meet.google.com/abc-defg-hij');
    await api('/customer-auth/logout', 'POST');
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
      await api('/customer-auth/logout', 'POST');
      for (const w of [1440, 1280, 1024, 820, 390]) {
        await width(w); await navigate(`${prefixPath}/forgot-password`); await wait("!!document.querySelector('input[name=email]')"); await checkLayout(`Forgot password ${lang} ${w}`); await snapshot(`forgot-${lang}-${w}`);
        await navigate(`${prefixPath}/reset-password#token=${'x'.repeat(43)}`); await wait("!!document.querySelector('input[name=confirmPassword]')"); await checkLayout(`Reset password ${lang} ${w}`); await snapshot(`reset-${lang}-${w}`);
        await navigate(`${prefixPath}/reset-password#token=invalid`); await wait("!!document.querySelector('[role=\"alert\"]')"); await checkLayout(`Invalid reset ${lang} ${w}`); await snapshot(`reset-invalid-${lang}-${w}`);
      }
    }
    // GIS callback and backend verifier are the only mocked boundaries. Customer
    // linking, DB transactions, Redis sessions, CSRF and booking remain real.
    for (const lang of ['vi', 'en']) {
      const p = lang === 'en' ? '/en' : '';
      if ((await api('/customer-auth/me')).status === 200) await api('/customer-auth/logout', 'POST');
      for (const w of [1440, 1280, 1024, 820, 390]) {
        await width(w); await navigate(`${p}/booking`);
        const loginSelector = w < 1024 ? '.neotek-navbar__mobile-footer .neotek-navbar__login' : '.neotek-navbar__actions .neotek-navbar__login';
        if (w < 1024) await click('.neotek-navbar__menu-button');
        await wait(`!!document.querySelector(${JSON.stringify(loginSelector)})`);
        assert(await evaluate(`document.querySelector(${JSON.stringify(loginSelector)}).getAttribute('href').startsWith('${p}/login')`));
        assert(await evaluate(`!!document.querySelector('${w < 1024 ? '.neotek-navbar__mobile-footer' : '.neotek-navbar__actions'} a[href="${p}/register"]')`));
        await checkLayout(`Anonymous navbar Login and Demo ${lang} ${w}`); await snapshot(`navbar-anonymous-${lang}-${w}`);
        if (w < 1024) { await key('Escape'); await wait("!document.querySelector('.neotek-navbar__dialog')"); }
        await width(w); await navigate(`${p}/login?returnTo=${encodeURIComponent(p + '/account/bookings')}`); await wait("!!document.querySelector('.gis-fixture')");
        assert.equal(await evaluate("document.querySelector('.gis-fixture').textContent"), lang === 'en' ? 'Continue with Google' : 'Tiếp tục với Google');
        await checkLayout(`Google Login ${lang} ${w}`); await snapshot(`google-login-${lang}-${w}`);
        assert(await evaluate("!!(document.querySelector('.auth-submit').compareDocumentPosition(document.querySelector('.auth-google')) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(document.querySelector('.auth-google-divider').compareDocumentPosition(document.querySelector('.gis-fixture')) & Node.DOCUMENT_POSITION_FOLLOWING)"));
        await click('.auth-switch a'); await wait(`location.pathname==='${p}/register' && !!document.querySelector('.gis-fixture')`);
        assert.equal(await evaluate('window.__gisInitializations'), 1, 'SPA navigation must initialize GIS once');
        assert.equal(await evaluate("new URLSearchParams(location.search).get('returnTo')"), p + '/account/bookings');
        await checkLayout(`Google Register ${lang} ${w}`); await snapshot(`google-register-${lang}-${w}`);
        assert(await evaluate("!!(document.querySelector('.auth-submit').compareDocumentPosition(document.querySelector('.auth-google')) & Node.DOCUMENT_POSITION_FOLLOWING)"));
        results.push(`Google below credentials/primary action with preceding separator ${lang} ${w}`);
        assert.equal(await evaluate("getComputedStyle(document.querySelector('.auth-form-grid')).gridTemplateColumns.split(' ').length"), w < 481 ? 1 : 2);
        results.push(`Compact Register grid ${lang} ${w}`);
      }
      await width(1440);
      // Backend failure leaves the ordinary form available and never signs in.
      await navigate(`${p}/login`); await click('.gis-fixture'); await wait("!!document.querySelector('[role=alert]')");
      assert.equal((await api('/customer-auth/me')).status, 401); assert(await evaluate("!!document.querySelector('input[name=password]:not(:disabled)')"));
      results.push(`Google ${lang}: backend rejection preserves password fallback`);
      gisMode = 'failure'; await navigate(`${p}/login`); await wait("document.querySelector('.auth-google [role=status]')?.textContent.includes(" + JSON.stringify(lang === 'en' ? 'unavailable' : 'chưa khả dụng') + ")");
      assert(await evaluate("!!document.querySelector('input[name=password]:not(:disabled)')")); results.push(`Google ${lang}: GIS load failure fallback`); gisMode = 'success';
      // Simulate a missing compiled Vite client ID at the test HTTP asset boundary.
      googleConfigAbsent = true; await navigate(`${p}/register`); await wait("!!document.querySelector('input[name=confirm]')"); await sleep(250);
      assert.equal(await evaluate("!!document.querySelector('.auth-google')"), false); results.push(`Google ${lang}: absent client ID fallback`); googleConfigAbsent = false;
      const email = `${randomUUID()}@gmail.com`, subject = randomUUID(), credential = `fixture.${randomUUID().replaceAll('-', '')}.signature`;
      googleFixtures.set(credential, { subject, email, name: 'Google browser customer', authoritativeEmail: true });
      await navigate(`${p}/register?returnTo=${encodeURIComponent(p + '/account/bookings')}`); await wait("!!document.querySelector('.gis-fixture')"); await evaluate(`window.__googleCredential=${JSON.stringify(credential)}`); await click('.gis-fixture');
      await wait(`location.pathname==='${p}/account/bookings' && !!document.querySelector('.customer-bookings-panel')`);
      const me = await api('/customer-auth/me'); assert.equal(me.status, 200); assert.equal(me.data.customer.email, email); assert(me.data.customer.emailVerifiedAt); assert.equal((await api('/booking/mine')).status, 200);
      const account = await db.customerAccount.findUniqueOrThrow({ where: { email } }); assert.equal(account.passwordHash, null); assert.equal(await db.notificationDelivery.count({ where: { customerId: account.id } }), 0);
      await logoutMenu(); assert.equal((await api('/customer-auth/me')).status, 401); assert.equal(await evaluate('window.__googleSignedOut'), true);
      results.push(`Google ${lang}: Register callback, normal /me, My Bookings, verified account without password/mail and logout`);
      await navigate(`${p}/booking`); for (let n = 0; n < 2; n++) await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
      await select(2, 20); await click('.booking-form__submit'); await wait(`location.pathname==='${p}/login' && !!document.querySelector('.gis-fixture')`);
      const intent = await evaluate("sessionStorage.getItem('neotek-booking-intent')"); assert(intent);
      await evaluate(`window.__googleCredential=${JSON.stringify(credential)}`); await click('.gis-fixture'); await wait(`location.pathname==='${p}/booking' && !!document.querySelector('.booking-hold-status')`);
      const hold = (await api('/booking/hold')).data.hold; assert(hold); assert.equal(hold.moduleKey, JSON.parse(intent).moduleKey); assert(!await evaluate("JSON.stringify({...localStorage,...sessionStorage}).includes('fixture.')"));
      assert.equal(await db.customerOAuthIdentity.count({ where: { customerId: account.id } }), 1);
      await click('.booking-dialog__heading button'); await wait("!document.querySelector('[role=dialog]')");
      for (const w of [1440, 1280, 1024, 820, 390]) {
        await width(w);
        assert.equal(await evaluate("!!document.querySelector('.neotek-navbar__login, .neotek-navbar__cta, .neotek-navbar a[href$=register]')"), false);
        assert.equal(await evaluate("!!document.querySelector('.booking-sidebar a[href*=login], .booking-sidebar a[href*=bookings]')"), false);
        assert.equal(await evaluate("Array.from(document.querySelectorAll('.booking-sidebar button')).some(b=>/Đăng xuất|Sign out/.test(b.textContent))"), false);
        const trigger = await accountMenu(w);
        assert.equal(await evaluate(`document.querySelector(${JSON.stringify(trigger)}).querySelector('.neotek-navbar__avatar').textContent`), Array.from(account.name.trim() || email)[0].toLocaleUpperCase());
        assert.equal(await evaluate("document.querySelector('.neotek-account-menu__header strong').textContent"), account.name);
        assert.equal(await evaluate("document.querySelector('.neotek-account-menu__header span').textContent"), email);
        assert.equal(await evaluate("document.querySelector('.neotek-account-menu a').getAttribute('href')"), `${p}/account/bookings`);
        await checkLayout(`Authenticated avatar and Radix account menu ${lang} ${w}`); await snapshot(`navbar-account-${lang}-${w}`);
        await key('Escape'); await wait("!document.querySelector('.neotek-account-menu')");
        assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(trigger)})`), true);
        if (w < 1024) { await key('Escape'); await wait("!document.querySelector('.neotek-navbar__dialog')"); }
        results.push(`Radix account keyboard and focus return, no sidebar auth ${lang} ${w}`);
      }
      await width(1440); await accountMenu(1440); await key('Enter'); await wait(`location.pathname==='${p}/account/bookings'`);
      assert.equal((await api('/booking/mine')).status, 200); results.push(`Account dropdown navigates to My Bookings ${lang}`);
      for (const route of ['login', 'register', 'forgot-password']) { await navigate(`${p}/${route}`); await wait(`location.pathname==='${p}/${route === 'forgot-password' ? 'account/bookings' : 'booking'}'`); assert.equal(await evaluate("!!document.querySelector('.auth-form')"), false); }
      results.push(`Authenticated customers redirect from guest-only routes ${lang}`);
      await navigate(`${p}/account/bookings`); await logoutMenu();
      results.push(`Google ${lang}: Login callback preserves booking intent, server reacquires hold, stable identity and no token storage`);
      await navigate(`${p}/login?returnTo=https%3A%2F%2Fevil.test`); await wait("!!document.querySelector('.gis-fixture')"); await evaluate(`window.__googleCredential=${JSON.stringify(credential)}`); await click('.gis-fixture'); await wait(`location.pathname==='${p}/booking'`); assert.equal(await evaluate('location.origin'), origin);
      await navigate(`${p}/account/bookings`); await evaluate("window.google={accounts:{id:{disableAutoSelect(){throw new Error('GIS signout unavailable')}}}}"); await logoutMenu(); await wait("!document.querySelector('.customer-bookings-panel')"); assert.equal((await api('/customer-auth/me')).status, 401); results.push(`Google ${lang}: unsafe returnTo rejected and GIS failure cannot prevent logout state clearing`);
      await navigate(`${p}/login`); await wait("!!document.querySelector('.gis-fixture')"); await evaluate(`window.__googleCredential=${JSON.stringify(credential)}`); await click('.gis-fixture'); await wait(`location.pathname==='${p}/booking'`);
      await width(1440); for (let n = 0; n < 2; n++) await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
      await select(3, 20); await click('.booking-form__submit'); await wait("!!document.querySelector('.booking-hold-status')");
      const logoutHold = (await api('/booking/hold')).data.hold;
      await click('.booking-change-time'); await wait("!document.querySelector('.booking-dialog')"); assert.equal((await api('/booking/hold')).data.hold.id, logoutHold.id);
      await accountMenu(1440); await key('End'); await key('Enter'); await wait("!document.querySelector('.neotek-account-menu') && document.activeElement===document.querySelector('.neotek-navbar__actions .neotek-navbar__login')");
      assert.equal((await db.bookingHold.findUniqueOrThrow({ where: { id: logoutHold.id } })).status, 'RELEASED'); results.push(`Navbar logout releases held slot; Change time preserves prior hold until a deliberate action ${lang}`);
      assert.equal((await api('/customer-auth/me')).status, 401); results.push(`Account dropdown keyboard logout clears session and restores Login ${lang}`);
      await navigate(`${p}/login`); await wait("!!document.querySelector('.gis-fixture')"); await evaluate(`window.__googleCredential=${JSON.stringify(credential)}`); await click('.gis-fixture'); await wait(`location.pathname==='${p}/booking'`);
      for (let n = 0; n < 2; n++) await click('.booking-toolbar__navigation .booking-icon-button:last-of-type');
      // Both languages share the disposable calendar; use distinct final appointment times.
      await select(4, lang === 'en' ? 14 : 10); assert.equal((await api('/booking/hold')).data.hold, null);
      assert.equal(await evaluate("document.querySelector('#booking-name').value"), account.name);
      assert.equal(await evaluate("document.querySelector('#booking-email').value"), email);
      assert.equal(await evaluate("document.querySelector('#booking-email').readOnly"), true);
      await fill('#booking-company', 'Single action company'); await fill('#booking-phone', '+84 900 000 001');
      await submit('.booking-form'); await wait("!!document.querySelector('.booking-success')");
      assert.equal((await api('/booking/hold')).data.hold, null); assert.equal((await api('/booking/mine')).data.items.length, 1);
      results.push(`One Book now action acquires and finalizes with prefilled identity and all required details ${lang}`);
      await navigate(`${p}/account/bookings`); await logoutMenu();
    }
    // Domain account survives provider failures; HTTP/Jest tests cover retry bounds.
    assert.equal(exceptions.length, 0, `Unhandled browser exceptions: ${exceptions.join(',')}`);
    await fs.writeFile(path.join(reportDir, 'results.json'), JSON.stringify({ passed: results, unhandledExceptions: exceptions, transport: 'explicit local dev mailbox', redis: 'real, random namespace', postgres: 'disposable', google: 'Customer GIS/verifier and Calendar client boundary mocked; no live Google account or token', missingConfig: 'public client ID removed only from test HTTP asset responses', detailSlug: detailSlug || null }, null, 2));
    await fs.rm(path.join(reportDir, 'failure.txt'), { force: true });
    console.log(JSON.stringify({ browserChecks: results.length, unhandledExceptions: exceptions.length, artifacts: 'Neotek Frontend/docs/booking-phase2c-browser' }));
  } catch (error) {
    console.error(JSON.stringify({ completedChecks:results.length, lastChecks:results.slice(-3) }));
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
