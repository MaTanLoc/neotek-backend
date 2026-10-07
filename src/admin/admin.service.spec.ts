import { PageStatus, UserRole } from '@prisma/client';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  const prisma = {
    page: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    pageTranslation: { findUnique: jest.fn(), upsert: jest.fn() },
    pageSection: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    pageSectionTranslation: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const pageCache = {
    invalidatePageLocale: jest.fn().mockResolvedValue(undefined),
    invalidatePageLocales: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => jest.clearAllMocks());

  it('rejects single-locale FAQ structural changes', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.pageSection.findUnique.mockResolvedValue({
      type: 'faq',
      translations: [{ locale: 'vi', content: { items: [] } }],
      page: { slug: 'home' },
    });
    await expect(
      service.updateSectionTranslation('faq', 'vi', {
        content: { items: [{ key: 'new', question: '', answer: '' }] },
      }),
    ).rejects.toThrow('structure');
    expect(prisma.pageSectionTranslation.upsert).not.toHaveBeenCalled();
  });

  it('saves repeated bilingual items atomically and invalidates both locales', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.pageSection.findUnique.mockResolvedValue({
      type: 'faq',
      translations: [],
      page: { slug: 'home' },
    });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.pageSectionTranslation.upsert.mockImplementation(
      async ({ create }) => create,
    );
    const content = { items: [{ key: 'same', question: 'Q', answer: 'A' }] };
    await service.updateSectionTranslations('faq', {
      translations: { vi: { content }, en: { content } },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.pageSectionTranslation.upsert).toHaveBeenCalledTimes(2);
    expect(pageCache.invalidatePageLocales).toHaveBeenCalledWith('home', [
      'vi',
      'en',
    ]);
  });

  it('rejects divergent keys before starting a transaction', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.pageSection.findUnique.mockResolvedValue({
      type: 'faq',
      translations: [],
      page: { slug: 'home' },
    });
    await expect(
      service.updateSectionTranslations('faq', {
        translations: {
          vi: {
            content: { items: [{ key: 'vi-only', question: '', answer: '' }] },
          },
          en: { content: { items: [] } },
        },
      }),
    ).rejects.toThrow('same keys');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('preserves legacy divergent arrays during bilingual text edits', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    const vi = { items: [{ key: 'legacy', question: 'Q', answer: 'A' }] },
      en = { items: [] };
    prisma.pageSection.findUnique.mockResolvedValue({
      type: 'faq',
      translations: [
        { locale: 'vi', content: vi },
        { locale: 'en', content: en },
      ],
      page: { slug: 'home' },
    });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    await expect(
      service.updateSectionTranslations('faq', {
        translations: {
          vi: { content: { items: [{ ...vi.items[0], answer: 'Changed' }] } },
          en: { content: en },
        },
      }),
    ).resolves.toBeDefined();
  });

  it('creates a normalized draft page transactionally', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.page.create.mockResolvedValue({ id: 'page-1', slug: 'about' });

    await service.createPage({
      slug: ' About ',
      translations: [{ locale: 'VI', title: 'Giới thiệu' }],
    });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.page.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'about',
          translations: { create: [{ locale: 'vi', title: 'Giới thiệu' }] },
        }),
      }),
    );
  });

  it('sets publishedAt when an admin first publishes a page', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.page.findUnique.mockResolvedValue({
      slug: 'about',
      status: PageStatus.DRAFT,
      translations: [{ locale: 'vi' }],
    });
    prisma.page.update.mockResolvedValue({ status: PageStatus.PUBLISHED });

    await service.updatePage(
      'page-1',
      { status: PageStatus.PUBLISHED },
      { id: 'admin', email: 'a@example.com', name: null, role: UserRole.ADMIN },
    );

    expect(prisma.page.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PageStatus.PUBLISHED,
          publishedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('rejects editor metadata changes', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    await expect(
      service.updatePage(
        'page-1',
        { status: PageStatus.ARCHIVED },
        {
          id: 'editor',
          email: 'e@example.com',
          name: null,
          role: UserRole.EDITOR,
        },
      ),
    ).rejects.toThrow('Editors cannot change page metadata');
    expect(prisma.page.update).not.toHaveBeenCalled();
  });

  it('validates section content using the database section type', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.pageSection.findUnique.mockResolvedValue({
      id: 'section-1',
      type: 'faq',
      translations: [
        {
          locale: 'vi',
          content: { items: [{ question: 'Old', answer: 'Old' }] },
        },
      ],
      page: { slug: 'home' },
    });
    prisma.pageSectionTranslation.upsert.mockResolvedValue({
      id: 'translation-1',
    });

    await expect(
      service.updateSectionTranslation('section-1', 'vi', {
        content: { items: [{ question: 'Q', answer: 'A' }] },
      }),
    ).resolves.toEqual({ id: 'translation-1' });
    await expect(
      service.updateSectionTranslation('section-1', 'vi', {
        content: { items: [{ question: 'Q' }] },
      }),
    ).rejects.toThrow('Invalid content for section type "faq"');
    expect(prisma.pageSectionTranslation.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown section types before creation', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.page.findUnique.mockResolvedValue({ id: 'page-1' });
    await expect(
      service.createSection(
        'page-1',
        { key: 'team', type: 'unknown' },
        {
          id: 'admin',
          email: 'a@example.com',
          name: null,
          role: UserRole.ADMIN,
        },
      ),
    ).rejects.toThrow('Unknown section type');
    expect(prisma.pageSection.create).not.toHaveBeenCalled();
  });

  it('rejects foreign sections during reorder before opening the transaction', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.pageSection.findMany.mockResolvedValue([{ id: 'owned' }]);
    await expect(
      service.reorderSections('page-1', {
        sections: [
          { id: 'owned', sortOrder: 10 },
          { id: 'foreign', sortOrder: 20 },
        ],
      }),
    ).rejects.toThrow('All sections must belong to the page');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('invalidates only the updated page translation locale', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.page.findUnique.mockResolvedValue({ id: 'page-1', slug: 'home' });
    prisma.pageTranslation.findUnique.mockResolvedValue({
      title: 'Old title',
    });
    prisma.pageTranslation.upsert.mockResolvedValue({ id: 'translation-1' });

    await service.updateTranslation('page-1', 'VI', { title: 'New title' });

    expect(pageCache.invalidatePageLocale).toHaveBeenCalledWith('home', 'vi');
    expect(pageCache.invalidatePageLocales).not.toHaveBeenCalled();
  });

  it('invalidates every page locale after a section metadata update', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.pageSection.findUnique.mockResolvedValue({
      page: {
        slug: 'home',
        translations: [{ locale: 'vi' }, { locale: 'en' }],
      },
    });
    prisma.pageSection.update.mockResolvedValue({ id: 'section-1' });

    await service.updateSection('section-1', { enabled: false });

    expect(pageCache.invalidatePageLocales).toHaveBeenCalledWith('home', [
      'vi',
      'en',
    ]);
  });

  it('does not invalidate when the database update fails', async () => {
    const service = new AdminService(prisma as never, pageCache as never);
    prisma.pageSection.findUnique.mockResolvedValue({
      page: { slug: 'home', translations: [{ locale: 'vi' }] },
    });
    prisma.pageSection.update.mockRejectedValue(new Error('Database down'));

    await expect(
      service.updateSection('section-1', { enabled: false }),
    ).rejects.toThrow('Database down');
    expect(pageCache.invalidatePageLocales).not.toHaveBeenCalled();
  });
});
