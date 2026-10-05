import { buildContent, normalizeWordPressData, type SourcePost } from './import-localwp';

function post(
  type: string,
  meta: Record<string, string>,
  overrides: Partial<SourcePost> = {},
): SourcePost {
  return {
    id: 1,
    title: 'Title',
    content: '<p>Content</p>',
    excerpt: '',
    status: 'publish',
    slug: 'title',
    type,
    meta,
    ...overrides,
  };
}

describe('LocalWP import normalization', () => {
  it('groups locales, filters inactive records, and sorts by display order', () => {
    const plan = normalizeWordPressData([
      post('why_item', { language: 'en', display_order: '20', is_active: '1' }, { id: 2 }),
      post('why_item', { language: 'en', display_order: '10', is_active: '1' }, { id: 1 }),
      post('why_item', { language: 'vi', display_order: '10', is_active: '0' }, { id: 3 }),
    ]);

    expect(plan.counts['home.why.en']).toBe(2);
    expect(plan.updates.get('home')?.get('en')?.why).toEqual({
      items: [
        expect.objectContaining({ key: 'title' }),
        expect.objectContaining({ key: 'title' }),
      ],
    });
    expect(plan.skipped).toContain('why_item:3');
  });

  it('normalizes a hero record from its ACF fields', () => {
    expect(
      buildContent(
        post('hero_slide', {
          language: 'vi',
          slide_key: 'hero-1',
          image_url: 'https://example.test/hero.png',
          show_content: '1',
          headline: 'Headline',
        }),
        'hero_slide',
      ),
    ).toMatchObject({
      key: 'hero-1',
      desktopImage: 'https://example.test/hero.png',
      showContent: true,
      headline: 'Headline',
    });
  });

  it('normalizes FAQ source content without rewriting HTML', () => {
    const faq = post('faq', { language: 'vi' }, {
      title: 'Question',
      content: '<p>Answer</p>',
    });

    expect(faq.content).toBe('<p>Answer</p>');
  });
});
