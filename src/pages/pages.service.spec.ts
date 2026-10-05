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

  it('returns the Vietnamese home page by default', async () => {
    pageFindUnique.mockResolvedValue({
      slug: 'home',
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
      translations: [],
      sections: [],
    });

    await expect(
      service.findPublicPage('home', { locale: 'fr' }),
    ).rejects.toThrow(
      new NotFoundException('Page translation not found: home (fr)'),
    );
  });

  it('returns a cached page without querying Prisma', async () => {
    const cachedPage = {
      slug: 'home',
      locale: 'vi',
      title: 'Trang chủ',
      seo: { title: null, description: null },
      sections: [],
    };
    cacheGet.mockResolvedValue(JSON.stringify(cachedPage));

    await expect(service.findPublicPage('home', {})).resolves.toEqual(
      cachedPage,
    );

    expect(pageFindUnique).not.toHaveBeenCalled();
    expect(cacheGet).toHaveBeenCalledWith('cms:page:home:vi');
  });

  it('queries Prisma and caches a page on a cache miss', async () => {
    pageFindUnique.mockResolvedValue({
      slug: 'home',
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
