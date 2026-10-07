// Uses a test-owned detail page; all temporary module references are restored
// within the setup transaction. Existing business content is never replaced.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { AdminService } = require('../dist/src/admin/admin.service');
const { PagesService } = require('../dist/src/pages/pages.service');
const { CacheService } = require('../dist/src/cache/cache.service');
const { PageCacheInvalidationService } = require('../dist/src/cache/page-cache-invalidation.service');
const { emptyArticle, emptyDetailHero } = require('../dist/src/sections/validation/solution-detail.schemas');
const db = new PrismaClient(), cache = new CacheService();
const slug = 'cms-detail-check-' + randomUUID(), moduleKey = slug;
let ownedPage;
async function main() {
  await cache.onModuleInit();
  const admin = new AdminService(db, new PageCacheInvalidationService(cache));
  const pages = new PagesService(db, cache);
  ownedPage = await db.$transaction(async tx => {
    const section = await tx.pageSection.findFirst({ where: { page: { slug: 'solutions' }, type: 'solutionModules' }, include: { translations: true } });
    assert(section);
    for (const translation of section.translations) await tx.pageSectionTranslation.update({ where: { id: translation.id }, data: { content: { ...translation.content, items: [...translation.content.items, { key: moduleKey, slug, title: 'Test-owned detail', bullets: [] }] } } });
    const nested = new AdminService({ ...tx, $transaction: fn => fn(tx) }, new PageCacheInvalidationService(cache));
    const result = await nested.createSolutionDetail({ moduleKey });
    await assert.rejects(() => nested.createSolutionDetail({ moduleKey }), error => error.status === 409);
    for (const translation of section.translations) await tx.pageSectionTranslation.update({ where: { id: translation.id }, data: { content: translation.content } });
    return result;
  }, { isolationLevel: 'Serializable', timeout: 15000 });
  assert.equal(ownedPage.translations.length, 2);
  assert(ownedPage.sections.every(section => section.translations.length === 2));
  await assert.rejects(() => pages.findPublicPage(slug, { locale: 'vi' }), error => error.status === 404);
  const localized = language => ({ title: language, seoTitle: language, seoDescription: 'Test', hero: emptyDetailHero(language), article: { ...emptyArticle(), doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: language + ' article' }] }] } } });
  const body = { slug, status: 'PUBLISHED', visible: true, related: { moduleKeys: [] }, translations: { vi: localized('VI'), en: localized('EN') } };
  await cache.set(`cms:page:${slug}:vi`, 'stale'); await cache.set(`cms:page:${slug}:en`, 'stale');
  const unrelatedKey = 'cms:page:unrelated-check-' + randomUUID() + ':vi'; await cache.set(unrelatedKey, 'preserve', 60);
  try {
    await admin.saveSolutionDetail(ownedPage.id, body);
    assert.equal(await cache.get(`cms:page:${slug}:vi`), null); assert.equal(await cache.get(`cms:page:${slug}:en`), null); assert.equal(await cache.get(unrelatedKey), 'preserve');
    for (const locale of ['vi', 'en']) assert.equal((await pages.findPublicPage(slug, { locale })).kind, 'SOLUTION_DETAIL');
    assert((await pages.listSolutionDetails()).some(page => page.slug === slug));
    const broken = new AdminService(new Proxy(db, { get(target, prop) { if (prop !== '$transaction') return Reflect.get(target, prop); return fn => db.$transaction(async tx => { let count = 0; const original = tx.pageTranslation.upsert.bind(tx.pageTranslation); const proxy = { ...tx, pageTranslation: { ...tx.pageTranslation, upsert: args => { if (++count === 2) throw new Error('Simulated EN write failure'); return original(args); } } }; return fn(proxy); }, { isolationLevel: 'Serializable' }); } }), new PageCacheInvalidationService(cache));
    const failed = structuredClone(body); failed.translations.vi.title = 'Must roll back';
    await assert.rejects(() => broken.saveSolutionDetail(ownedPage.id, failed), /Simulated EN write failure/);
    assert.equal((await db.pageTranslation.findUnique({ where: { pageId_locale: { pageId: ownedPage.id, locale: 'vi' } } })).title, 'VI');
    const stalePublished = await cache.get(`cms:page:${slug}:vi`);
    await admin.saveSolutionDetail(ownedPage.id, { ...body, status: 'DRAFT' });
    // Simulate stale cache even after a best-effort invalidation failure.
    await cache.set(`cms:page:${slug}:vi`, stalePublished);
    await assert.rejects(() => pages.findPublicPage(slug, { locale: 'vi' }), error => error.status === 404);
    assert(!(await pages.listSolutionDetails()).some(page => page.slug === slug));
    assert.equal((await fetch('http://localhost:3000/api/admin/solutions')).status, 401);
    console.log('PASS PostgreSQL atomic create/save/EN-failure rollback; draft/publish; published availability; Redis exact-key invalidation and stale-draft protection; authenticated API boundary');
  } finally { await cache.del(unrelatedKey); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (ownedPage) { assert(ownedPage.slug.startsWith('cms-detail-check-')); await db.page.delete({ where: { id: ownedPage.id } }); for (const locale of ['vi', 'en']) await cache.del(`cms:page:${slug}:${locale}`); }
  await cache.onModuleDestroy(); await db.$disconnect();
});
