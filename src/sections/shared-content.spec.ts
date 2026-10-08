import { PagesService } from '../pages/pages.service';
import { resolveSharedTranslations, sharedSource } from './shared-content';
import { AdminService } from '../admin/admin.service';

describe('canonical section content', () => {
  const vi = { items: [{ question: 'VI', answer: 'VI answer' }] };
  const en = { items: [{ question: 'EN', answer: 'EN answer' }] };
  const refs = ['vi', 'en'].map((locale) => ({
    locale,
    content: { source: 'shared.faq' },
  }));
  function setup() {
    const db = {
      siteSetting: {
        findUnique: jest.fn(async ({ include }) => ({
          id: 'canonical',
          translations: [
            { value: include.translations.where.locale === 'vi' ? vi : en },
          ],
        })),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'canonical' }),
      },
      siteSettingTranslation: { update: jest.fn(async (input) => input.data) },
      pageSection: {
        findUnique: jest.fn().mockResolvedValue({
          type: 'faq',
          translations: refs,
          page: { slug: 'home' },
        }),
      },
      pageSectionTranslation: {
        findMany: jest.fn().mockResolvedValue(
          ['home', 'solutions'].flatMap((slug) =>
            ['vi', 'en'].map((locale) => ({
              locale,
              section: { page: { slug } },
            })),
          ),
        ),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation(async (callback) => callback(db));
    const cache = {
      invalidatePageLocale: jest.fn().mockResolvedValue(undefined),
    };
    return {
      db,
      cache,
      service: new AdminService(db as never, cache as never),
    };
  }
  it('resolves each locale independently without changing references', async () => {
    const { db } = setup();
    const result = await resolveSharedTranslations(db as never, refs);
    expect(result.map((t) => t.content)).toEqual([vi, en]);
    expect(refs[0].content).toEqual({ source: 'shared.faq' });
    expect(sharedSource({ source: 'site.navigation' })).toBeUndefined();
  });
  it('fails closed for missing canonical translation rather than falling back to VI', async () => {
    const { db } = setup();
    db.siteSetting.findUnique.mockResolvedValueOnce({
      id: 'canonical',
      translations: [],
    });
    await expect(resolveSharedTranslations(db as never, refs)).rejects.toThrow(
      'Shared content missing',
    );
  });
  it('saves VI/EN once and invalidates both consuming pages without copying JSON', async () => {
    const { db, cache, service } = setup();
    await service.updateSectionTranslations('section', {
      translations: {
        vi: { content: { ...vi, title: 'Changed' } },
        en: { content: en },
      },
    });
    expect(db.siteSettingTranslation.update).toHaveBeenCalledTimes(2);
    expect(db.pageSectionTranslation.upsert).not.toHaveBeenCalled();
    expect(cache.invalidatePageLocale.mock.calls).toEqual([
      ['home', 'vi'],
      ['home', 'en'],
      ['solutions', 'vi'],
      ['solutions', 'en'],
    ]);
  });
  it('preserves collection safety checks after resolving references', async () => {
    const { db, service } = setup();
    await expect(
      service.updateSectionTranslations('section', {
        translations: {
          vi: {
            content: { items: [{ key: 'new', question: 'VI', answer: '' }] },
          },
          en: { content: en },
        },
      }),
    ).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('updates only the chosen locale for nonstructural single-locale edits', async () => {
    const { db, cache, service } = setup();
    await service.updateSectionTranslation('section', 'en', {
      content: { ...en, title: 'English' },
    });
    expect(db.siteSettingTranslation.update).toHaveBeenCalledTimes(1);
    expect(cache.invalidatePageLocale.mock.calls).toEqual([
      ['home', 'en'],
      ['solutions', 'en'],
    ]);
  });
  it('returns canonical English content for both public pages', async () => {
    const { db } = setup();
    const page = jest.fn(async ({ where }) => ({
      slug: where.slug,
      status: 'PUBLISHED',
      translations: [{ title: 'Page', seoTitle: null, seoDescription: null }],
      sections: [{ key: 'faq', type: 'faq', translations: [refs[1]] }],
    }));
    const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn() };
    const service = new PagesService(
      { ...db, page: { findUnique: page } } as never,
      cache as never,
    );
    for (const slug of ['home', 'solutions']) {
      const response = await service.findPublicPage(slug, { locale: 'en' });
      expect(response.sections[0].content).toEqual(en);
      expect(response.sections[0].content).not.toHaveProperty('source');
    }
  });
});
