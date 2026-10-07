/* global structuredClone */
import { createSolutionDetail, detailAvailability } from './solution-detail';
import { ConflictException, BadRequestException } from '@nestjs/common';
describe('Solution detail creation and availability', () => {
  const modules = ['vi', 'en'].map((locale) => ({
    locale,
    content: {
      items: [{ key: 'hrPayroll', slug: 'nhan-su-tien-luong', title: locale }],
    },
  }));
  const create = jest.fn(),
    findUnique = jest.fn(),
    findMany = jest.fn();
  const db = { page: { create, findUnique, findMany } } as never;
  beforeEach(() => {
    jest.clearAllMocks();
    findUnique.mockImplementation(({ where }: { where: { slug: string } }) =>
      where.slug === 'solutions'
        ? { sections: [{ translations: structuredClone(modules) }] }
        : null,
    );
  });
  it('creates both translations and all paired sections in one nested write', async () => {
    await createSolutionDetail(db, 'hrPayroll');
    const data = create.mock.calls[0][0].data;
    expect(data.kind).toBe('SOLUTION_DETAIL');
    expect(
      data.translations.create.map((item: { locale: string }) => item.locale),
    ).toEqual(['vi', 'en']);
    expect(data.sections.create).toHaveLength(3);
    for (const section of data.sections.create)
      expect(
        section.translations.create.map(
          (item: { locale: string }) => item.locale,
        ),
      ).toEqual(['vi', 'en']);
  });
  it('prevents duplicate creation without writing', async () => {
    findUnique.mockImplementation(({ where }: { where: { slug: string } }) =>
      where.slug === 'solutions'
        ? { sections: [{ translations: modules }] }
        : { id: 'exists' },
    );
    await expect(createSolutionDetail(db, 'hrPayroll')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects absent modules and nonmatching locale slugs', async () => {
    await expect(createSolutionDetail(db, 'missing')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    findUnique.mockResolvedValue({
      sections: [
        {
          translations: [
            modules[0],
            {
              locale: 'en',
              content: { items: [{ key: 'hrPayroll', slug: 'different' }] },
            },
          ],
        },
      ],
    });
    await expect(createSolutionDetail(db, 'hrPayroll')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('public availability filters to published pages with readable locale content', async () => {
    findMany.mockResolvedValue([
      {
        id: 'detail',
        slug: 'hr',
        status: 'PUBLISHED',
        translations: [
          { locale: 'vi', title: 'HR' },
          { locale: 'en', title: '' },
        ],
        sections: [
          { type: 'solutionDetailHero', enabled: true },
          {
            type: 'solutionArticle',
            enabled: true,
            translations: [
              {
                locale: 'vi',
                content: {
                  doc: {
                    type: 'doc',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: 'Article' }],
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    ]);
    expect(await detailAvailability(db, true)).toEqual([
      { id: 'detail', slug: 'hr', status: 'PUBLISHED', locales: ['vi'] },
    ]);
    expect(findMany.mock.calls[0][0].where).toEqual({
      kind: 'SOLUTION_DETAIL',
      status: 'PUBLISHED',
    });
  });
});
