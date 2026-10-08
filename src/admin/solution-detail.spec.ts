import { AdminService } from './admin.service';
import {
  emptyArticle,
  emptyDetailHero,
} from '../sections/validation/solution-detail.schemas';
import { BadRequestException, NotFoundException } from '@nestjs/common';
describe('Atomic solution-detail manager saves', () => {
  const findUnique = jest.fn(),
    update = jest.fn(),
    upsert = jest.fn(),
    sectionUpdate = jest.fn();
  const db = {
    page: { findUnique, update },
    pageTranslation: { upsert },
    pageSection: { update: sectionUpdate },
    pageSectionTranslation: { upsert },
    $transaction: jest.fn(),
  };
  const cache = { invalidatePageLocales: jest.fn() };
  const service = new AdminService(db as never, cache as never);
  const locale = () => ({
    title: 'Detail',
    seoTitle: null,
    seoDescription: null,
    hero: emptyDetailHero('Detail'),
    article: emptyArticle(),
  });
  const body = () => ({
    slug: 'detail',
    status: 'DRAFT',
    visible: true,
    related: { moduleKeys: [] },
    translations: { vi: locale(), en: locale() },
  });
  beforeEach(() => {
    jest.clearAllMocks();
    upsert.mockResolvedValue({});
    update.mockResolvedValue({});
    sectionUpdate.mockResolvedValue({});
    findUnique.mockImplementation(
      ({ where }: { where: { slug?: string; id?: string } }) =>
        where.slug === 'solutions'
          ? {
              sections: [
                {
                  translations: ['vi', 'en'].map((locale) => ({
                    locale,
                    content: { items: [] },
                  })),
                },
              ],
            }
          : {
              id: 'id',
              slug: 'detail',
              kind: 'SOLUTION_DETAIL',
              sections: ['hero', 'article', 'related'].map((key) => ({
                id: key,
                key,
              })),
            },
    );
    // eslint-disable-next-line no-unused-vars -- Transaction callback signature.
    db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) =>
      fn(db),
    );
  });
  it('writes both languages and section content in one serializable transaction', async () => {
    await service.saveSolutionDetail('id', body());
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(upsert).toHaveBeenCalledTimes(8);
    expect(cache.invalidatePageLocales).toHaveBeenCalledWith('detail', [
      'vi',
      'en',
    ]);
  });
  it('propagates transaction failure and does not invalidate a failed save', async () => {
    upsert.mockRejectedValueOnce(new Error('write failure'));
    await expect(service.saveSolutionDetail('id', body())).rejects.toThrow(
      'write failure',
    );
    expect(cache.invalidatePageLocales).not.toHaveBeenCalled();
  });
  it('rejects unknown slugs and empty publication before writes', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.getSolutionDetail('unknown')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.saveSolutionDetail('id', { ...body(), status: 'PUBLISHED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });
  it('rejects mixed-language shared cover values', async () => {
    const input = body();
    input.translations.vi.hero.cover = '/assets/bg-cta-auth.png';
    await expect(
      service.saveSolutionDetail('id', input),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects excessive nesting with 400 before recursive validation or DB work', async () => {
    let nested: unknown = { type: 'paragraph', content: [] };
    for (let level = 0; level < 500; level++)
      nested = { type: 'blockquote', content: [nested] };
    const input = body();
    input.translations.vi.article.doc = {
      type: 'doc',
      content: [nested],
    } as never;
    await expect(service.saveSolutionDetail('id', input)).rejects.toMatchObject(
      { status: 400 },
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
