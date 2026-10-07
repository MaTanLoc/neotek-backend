// No schema migration. Run --dry-run before explicitly applying references.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const db = new PrismaClient();
const args = process.argv.slice(2);
if (![1, 3].includes(args.length) || !['--dry-run', '--apply'].includes(args[0]) || (args.length === 3 && (args[1] !== '--section' || args[2] !== 'trustedBy'))) throw new Error('Use --dry-run or --apply, optionally --section trustedBy');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function main() {
  // Read and compare again inside the apply transaction to prevent stale plans.
  await db.$transaction(async tx => {
    const pages = await tx.page.findMany({ where: { slug: { in: ['home', 'solutions'] } }, include: { sections: { include: { translations: true } } } });
    const plans = [];
    for (const [type, key] of [['cta', 'cta'], ['cta', 'footerCta'], ['faq', 'faq'], ['trustedLogos', 'trustedBy']]) {
      if (args[2] && key !== args[2]) continue;
      const sections = pages.flatMap(page => page.sections.filter(section => section.type === type && section.key === key).map(section => ({ ...section, slug: page.slug })));
      const unresolved = sections.filter(section => section.translations.every(t => !t.content.source));
      if (!unresolved.length) continue;
      if (unresolved.some(section => !['vi', 'en'].every(locale => section.translations.some(t => t.locale === locale)))) throw new Error(`Missing VI/EN: ${key}`);
      // Home is the seed for the confirmed shared business sections. A legacy
      // empty Trusted placeholder may bind to that source, but populated
      // divergent copies require review and are never silently overwritten.
      unresolved.sort((a, b) => Number(b.slug === 'home') - Number(a.slug === 'home'));
      const shared = key !== 'footerCta';
      const same = ['vi', 'en'].every(locale => unresolved.every(section => {
        const content = section.translations.find(t => t.locale === locale).content;
        const seed = unresolved[0].translations.find(t => t.locale === locale).content;
        if (isDeepStrictEqual(content, seed)) return true;
        return key === 'trustedBy' && (content.items || []).length === 0 && isDeepStrictEqual({ ...content, items: seed.items }, seed);
      }));
      if (shared && !same) throw new Error('Divergent confirmed shared content: ' + key + '; resolve copies before applying');
      for (const group of shared ? [unresolved] : unresolved.map(section => [section])) {
        const source = `shared.${key === 'trustedBy' ? 'trustedLogos' : key}${shared || key === 'footerCta' ? '' : '.' + group[0].slug}`;
        const existing = await tx.siteSetting.findUnique({ where: { key: source }, include: { translations: true } });
        if (existing && !['vi', 'en'].every(locale => isDeepStrictEqual(existing.translations.find(t => t.locale === locale)?.value, group[0].translations.find(t => t.locale === locale).content))) throw new Error(`Canonical conflict: ${source}; no overwrite`);
        plans.push({ source, create: !existing, sections: group.map(s => ({ id: s.id, page: s.slug, key: s.key, translations: s.translations.map(t => ({ id: t.id, locale: t.locale, sha256: digest(t.content) })) })) });
        if (args[0] === '--apply') {
          if (!existing) await tx.siteSetting.create({ data: { key: source, translations: { create: group[0].translations.map(t => ({ locale: t.locale, value: t.content })) } } });
          for (const section of group) for (const translation of section.translations) await tx.pageSectionTranslation.update({ where: { id: translation.id }, data: { content: { source } } });
        }
      }
    }
    console.log(JSON.stringify({ mode: args[0], plans }, null, 2));
    if (args[0] === '--apply' && plans.length) {
      // Exact CMS keys only, inside transaction: failed invalidation aborts DB writes.
      const { createClient } = require('redis');
      const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379', socket: { reconnectStrategy: false } });
      redis.on('error', () => {});
      await redis.connect();
      try { for (const page of pages) for (const locale of ['vi', 'en']) await redis.del(`cms:page:${page.slug}:${locale}`); }
      finally { await redis.quit(); }
    }
  }, { isolationLevel: 'Serializable', timeout: 15000 });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
