import { NotFoundException } from '@nestjs/common';
import { PagesService } from './pages.service';

describe('PagesService', () => {
  const pageFindUnique = jest.fn();
  const cacheGet = jest.fn();
  const cacheSet = jest.fn();
  const cacheDel = jest.fn();
  const service = new PagesService(
    {
      page: { findUnique: pageFindUnique },
    } as never,
    {
      get: cacheGet,
      set: cacheSet,
      del: cacheDel,
    } as never,
  );

  beforeEach(() => {
    pageFindUnique.mockReset();
    cacheGet.mockReset().mockResolvedValue(null);
    cacheSet.mockReset().mockResolvedValue(undefined);
    cacheDel.mockReset().mockResolvedValue(undefined);
  });

  it.each(
    ['DRAFT', 'ARCHIVED'].flatMap((status) =>
      ['STANDARD', 'SOLUTION_DETAIL'].map((kind) => [status, kind]),
    ),
  )('hides %s %s pages publicly', async (status, kind) => {
    pageFindUnique.mockResolvedValue({
      kind,
      status,
      sections: [],
    });
    await expect(
      service.findPublicPage('detail', { locale: 'vi' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(cacheSet).not.toHaveBeenCalled();
  });
  it('returns a published detail and hides its empty English translation', async () => {
    const page = {
      slug: 'detail',
      kind: 'SOLUTION_DETAIL',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      updatedAt: new Date(),
      translations: [{ title: 'Detail', seoTitle: null, seoDescription: null }],
      sections: [
        {
          key: 'hero',
          type: 'solutionDetailHero',
          translations: [{ locale: 'vi', content: {} }],
        },
        {
          key: 'article',
          type: 'solutionArticle',
          translations: [
            {
              locale: 'vi',
              content: {
                doc: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [{ type: 'text', text: 'Readable article' }],
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    };
    pageFindUnique.mockResolvedValue(page);
    expect(
      (await service.findPublicPage('detail', { locale: 'vi' })).kind,
    ).toBe('SOLUTION_DETAIL');
    page.translations[0].title = '';
    await expect(
      service.findPublicPage('detail', { locale: 'en' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the Vietnamese home page by default', async () => {
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [
        {
          title: 'Trang chủ',
          seoTitle: null,
          seoDescription: null,
        },
      ],
      sections: [
        {
          key: 'hero',
          type: 'hero',
          translations: [{ content: {} }],
        },
      ],
    });

    await expect(service.findPublicPage('home', {})).resolves.toEqual({
      slug: 'home',
      locale: 'vi',
      title: 'Trang chủ',
      seo: {
        title: null,
        description: null,
      },
      sections: [
        {
          key: 'hero',
          type: 'hero',
          content: {},
        },
      ],
    });
  });

  it('returns the requested English page', async () => {
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [
        {
          title: 'Home',
          seoTitle: 'Home SEO',
          seoDescription: 'Home description',
        },
      ],
      sections: [],
    });

    await expect(
      service.findPublicPage('home', { locale: 'en' }),
    ).resolves.toMatchObject({
      locale: 'en',
      title: 'Home',
    });
  });

  it('preserves sort order and excludes disabled or untranslated sections', async () => {
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [{ title: 'Home', seoTitle: null, seoDescription: null }],
      sections: [
        {
          key: 'hero',
          type: 'hero',
          translations: [{ content: {} }],
        },
        {
          key: 'missing',
          type: 'missing',
          translations: [],
        },
      ],
    });

    const result = await service.findPublicPage('home', { locale: 'en' });

    expect(result.sections).toEqual([
      { key: 'hero', type: 'hero', content: {} },
    ]);
    expect(pageFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          sections: expect.objectContaining({
            where: { enabled: true },
            orderBy: { sortOrder: 'asc' },
          }),
        }),
      }),
    );
  });

  it('throws a 404 when the page does not exist', async () => {
    pageFindUnique.mockResolvedValue(null);

    await expect(service.findPublicPage('missing', {})).rejects.toThrow(
      new NotFoundException('Page not found: missing'),
    );
  });

  it('throws a 404 when the requested translation does not exist', async () => {
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [],
      sections: [],
    });

    await expect(
      service.findPublicPage('home', { locale: 'fr' }),
    ).rejects.toThrow(
      new NotFoundException('Page translation not found: home (fr)'),
    );
  });

  it('rechecks publication before returning a cached page', async () => {
    const cachedPage = {
      slug: 'home',
      status: 'PUBLISHED',
      locale: 'vi',
      title: 'Trang chủ',
      seo: { title: null, description: null },
      sections: [],
    };
    cacheGet.mockResolvedValue(JSON.stringify(cachedPage));
    pageFindUnique.mockResolvedValue({ kind: 'STANDARD', status: 'PUBLISHED' });

    await expect(service.findPublicPage('home', {})).resolves.toEqual(
      cachedPage,
    );

    expect(pageFindUnique).toHaveBeenCalled();
    expect(cacheGet).toHaveBeenCalledWith('cms:page:home:vi');
  });

  it('queries Prisma and caches a page on a cache miss', async () => {
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [{ title: 'Home', seoTitle: null, seoDescription: null }],
      sections: [],
    });

    const result = await service.findPublicPage('home', { locale: 'en' });

    expect(result.title).toBe('Home');
    expect(cacheSet).toHaveBeenCalledWith(
      'cms:page:home:en',
      JSON.stringify(result),
      300,
    );
  });

  it('falls back to Prisma when Redis read fails', async () => {
    cacheGet.mockRejectedValue(new Error('Redis unavailable'));
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [{ title: 'Home', seoTitle: null, seoDescription: null }],
      sections: [],
    });

    await expect(
      service.findPublicPage('home', { locale: 'en' }),
    ).resolves.toMatchObject({ title: 'Home' });
    expect(pageFindUnique).toHaveBeenCalled();
  });

  it('returns the Prisma response when Redis write fails', async () => {
    cacheSet.mockRejectedValue(new Error('Redis unavailable'));
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [{ title: 'Home', seoTitle: null, seoDescription: null }],
      sections: [],
    });

    await expect(
      service.findPublicPage('home', { locale: 'en' }),
    ).resolves.toMatchObject({ title: 'Home' });
  });

  it('refreshes the cache when cached JSON is malformed', async () => {
    cacheGet.mockResolvedValue('{invalid');
    pageFindUnique.mockResolvedValue({
      slug: 'home',
      status: 'PUBLISHED',
      translations: [{ title: 'Home', seoTitle: null, seoDescription: null }],
      sections: [],
    });

    const result = await service.findPublicPage('home', { locale: 'en' });

    expect(pageFindUnique).toHaveBeenCalled();
    expect(cacheDel).toHaveBeenCalledWith('cms:page:home:en');
    expect(cacheSet).toHaveBeenCalledWith(
      'cms:page:home:en',
      JSON.stringify(result),
      300,
    );
  });
});

describe('public publication cache boundary', () => {
  it('returns a cached published detail only after checking current status/version/visibility', async () => {
    const updatedAt = new Date();
    const response = {
      slug: 'detail',
      kind: 'SOLUTION_DETAIL',
      updatedAt: updatedAt.toISOString(),
      sections: [],
    };
    const findUnique = jest.fn().mockResolvedValue({
      kind: 'SOLUTION_DETAIL',
      status: 'PUBLISHED',
      updatedAt,
      sections: [
        { key: 'hero', enabled: true },
        { key: 'article', enabled: true },
      ],
    });
    const service = new PagesService(
      { page: { findUnique } } as never,
      { get: jest.fn().mockResolvedValue(JSON.stringify(response)) } as never,
    );
    await expect(service.findPublicPage('detail', {})).resolves.toEqual(
      response,
    );
    expect(findUnique).toHaveBeenCalled();
  });
  it.each(['STANDARD', 'SOLUTION_DETAIL'])(
    'blocks draft, archived and missing %s even with stale cache',
    async (kind) => {
      for (const status of ['DRAFT', 'ARCHIVED', null]) {
        const findUnique = jest
          .fn()
          .mockResolvedValue(status ? { kind, status, sections: [] } : null);
        const service = new PagesService(
          { page: { findUnique } } as never,
          {
            get: jest
              .fn()
              .mockResolvedValue(
                JSON.stringify({ slug: 'hidden', kind, sections: [] }),
              ),
            del: jest.fn().mockResolvedValue(undefined),
            set: jest.fn(),
          } as never,
        );
        await expect(
          service.findPublicPage('hidden', {}),
        ).rejects.toBeInstanceOf(NotFoundException);
      }
    },
  );
  it('sanitizes old FAQ cache entries without database writes', async () => {
    const service = new PagesService(
      {
        page: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ kind: 'STANDARD', status: 'PUBLISHED' }),
        },
      } as never,
      {
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            sections: [
              {
                type: 'faq',
                content: {
                  items: [{ answer: '<p onclick="bad()">Safe</p>' }],
                },
              },
            ],
          }),
        ),
      } as never,
    );
    expect(
      (await service.findPublicPage('home', {})).sections[0].content,
    ).toEqual({ items: [{ answer: '<p>Safe</p>' }] });
  });
});
