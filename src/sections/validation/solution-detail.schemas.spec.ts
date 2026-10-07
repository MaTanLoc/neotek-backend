import {
  emptyArticle,
  solutionArticleSchema,
  detailSlugSchema,
  safeImage,
  safeDestination,
  detailSaveSchema,
  emptyDetailHero,
} from './solution-detail.schemas';
describe('Solution detail document safety', () => {
  const article = (node: unknown) => ({
    version: 1,
    doc: { type: 'doc', content: [node] },
  });
  it('accepts a controlled document and independently structured locales', () => {
    const vi = {
      title: 'Title',
      seoTitle: null,
      seoDescription: null,
      hero: emptyDetailHero('Title'),
      article: emptyArticle(),
    };
    expect(
      detailSaveSchema.safeParse({
        slug: 'hr-payroll',
        status: 'DRAFT',
        visible: true,
        related: { moduleKeys: [] },
        translations: {
          vi,
          en: {
            ...vi,
            article: article({
              type: 'heading',
              attrs: { level: 2 },
              content: [{ type: 'text', text: 'English section' }],
            }),
          },
        },
      }).success,
    ).toBe(true);
  });
  it.each(['script', 'iframe', 'html', 'style', 'codeBlock'])(
    'rejects unknown node %s',
    (type) =>
      expect(solutionArticleSchema.safeParse(article({ type })).success).toBe(
        false,
      ),
  );
  it('rejects H1, arbitrary attrs, malformed lists, duplicate media IDs and excessive depth', () => {
    expect(
      solutionArticleSchema.safeParse(
        article({ type: 'heading', attrs: { level: 1 } }),
      ).success,
    ).toBe(false);
    expect(
      solutionArticleSchema.safeParse(
        article({ type: 'paragraph', attrs: { onclick: 'x' } }),
      ).success,
    ).toBe(false);
    expect(
      solutionArticleSchema.safeParse(
        article({ type: 'bulletList', content: [{ type: 'paragraph' }] }),
      ).success,
    ).toBe(false);
    const image = {
      type: 'articleImage',
      attrs: {
        id: 'same',
        src: '/assets/logo/logo_306x98.png',
        alt: '',
        caption: '',
        display: 'wide',
      },
    };
    expect(
      solutionArticleSchema.safeParse({
        version: 1,
        doc: { type: 'doc', content: [image, image] },
      }).success,
    ).toBe(false);
    let node: unknown = { type: 'paragraph' };
    for (let i = 0; i < 15; i++) node = { type: 'blockquote', content: [node] };
    expect(solutionArticleSchema.safeParse(article(node)).success).toBe(false);
  });
  it.each([
    'javascript:alert(1)',
    '//evil.test',
    'data:text/html,x',
    '/bad\\path',
    'https://name:pass@test.test',
  ])('rejects unsafe destination %s', (value) =>
    expect(safeDestination.safeParse(value).success).toBe(false),
  );
  it('allows controlled URLs and rejects untrusted image origins', () => {
    expect(safeDestination.safeParse('/booking').success).toBe(true);
    expect(safeDestination.safeParse('https://neotek.vn/booking').success).toBe(
      true,
    );
    expect(
      safeImage.safeParse(
        'https://res.cloudinary.com/demo/image/upload/test.png',
      ).success,
    ).toBe(true);
    expect(safeImage.safeParse('https://evil.test/image.png').success).toBe(
      false,
    );
  });
  it.each(['../bad', 'solutions', 'en/hello', 'Hello', 'two words'])(
    'rejects invalid or reserved slug %s',
    (slug) => expect(detailSlugSchema.safeParse(slug).success).toBe(false),
  );
});
