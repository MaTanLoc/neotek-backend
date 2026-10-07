import {
  SectionContentValidationError,
  validateSectionContent,
} from './section-content.registry';

describe('section content registry', () => {
  it('accepts legacy avatars and bounds non-destructive focal controls', () => {
    const item = {
      name: 'Customer',
      image: 'https://res.cloudinary.com/demo/image/upload/avatar.png',
    };
    expect(
      validateSectionContent('testimonials', { items: [item] }),
    ).toBeDefined();
    expect(
      validateSectionContent('testimonials', {
        items: [{ ...item, focalX: 72, focalY: 40, zoom: 1.5 }],
      }),
    ).toBeDefined();
    for (const patch of [
      { focalX: -1 },
      { focalY: 101 },
      { zoom: 0.9 },
      { zoom: 2.6 },
      { focalX: '50' },
    ]) {
      expect(() =>
        validateSectionContent('testimonials', {
          items: [{ ...item, ...patch }],
        }),
      ).toThrow();
    }
  });

  it('accepts an optional group image without changing legacy module membership', () => {
    const item = { key: 'business', modules: ['crm'] };
    expect(
      validateSectionContent('solutionGroups', { items: [item] }),
    ).toBeDefined();
    expect(
      validateSectionContent('solutionGroups', {
        items: [{ ...item, visualSrc: '/group.png' }],
      }),
    ).toBeDefined();
  });
  it('validates logo sizing without requiring legacy fields', () => {
    expect(
      validateSectionContent('trustedLogos', {
        title: 'Customers',
        items: [
          {
            key: 'logo',
            alt: 'Logo',
            width: 180,
            maxWidth: 200,
            height: 80,
            scale: 1.2,
            objectFit: 'contain',
          },
        ],
      }),
    ).toBeDefined();
    expect(() =>
      validateSectionContent('trustedLogos', {
        items: [{ key: 'logo', alt: 'Logo', scale: 10 }],
      }),
    ).toThrow('scale');
    expect(() =>
      validateSectionContent('trustedLogos', {
        items: [{ key: 'logo', alt: 'Logo', width: -1 }],
      }),
    ).toThrow('width');
  });
  it('validates the Home overview and rejects raw CSS', () => {
    const content = {
      title: 'Overview',
      items: [
        {
          key: 'business',
          title: 'Business',
          image: '/image.png',
          modules: [{ key: 'crm', title: 'CRM', icon: 'Users', url: '' }],
        },
      ],
    };
    expect(validateSectionContent('solutionOverview', content)).toBeDefined();
    expect(() =>
      validateSectionContent('solutionOverview', { ...content, css: 'body{}' }),
    ).toThrow();
  });
  it('accepts imported hero content', () => {
    expect(
      validateSectionContent('hero', {
        slides: [
          {
            key: 'hero-1',
            showContent: true,
            primaryCta: { enabled: true, label: 'Read', url: '/read' },
            secondaryCta: { enabled: false },
          },
        ],
      }),
    ).toBeDefined();
  });

  it('rejects invalid hero content with a useful path', () => {
    expect(() =>
      validateSectionContent('hero', {
        slides: [{ key: 'hero-1', showContent: 'yes' }],
      }),
    ).toThrow('hero');
    expect(() =>
      validateSectionContent('hero', {
        slides: [{ key: 'hero-1', showContent: 'yes' }],
      }),
    ).toThrow('slides.0.showContent');
  });

  it('accepts FAQ and CTA content', () => {
    expect(
      validateSectionContent('faq', {
        items: [{ question: 'Question', answer: '<p>Answer</p>' }],
      }),
    ).toBeDefined();
    expect(
      validateSectionContent('cta', {
        items: [
          {
            title: 'Contact',
            primary: { label: 'Start', url: '/start' },
            secondary: { label: 'Learn', url: '/learn' },
          },
        ],
      }),
    ).toBeDefined();
  });

  it('accepts trusted logos and empty placeholder sections', () => {
    expect(
      validateSectionContent('trustedLogos', {
        items: [{ key: 'logo', alt: 'Logo', url: 'attachment-id' }],
      }),
    ).toBeDefined();
    expect(validateSectionContent('solutionOverview', {})).toEqual({});
    expect(validateSectionContent('solutionGroups', {})).toEqual({});
    expect(validateSectionContent('solutionModules', {})).toEqual({});
  });

  it('rejects unknown section types', () => {
    expect(() => validateSectionContent('unknown', {})).toThrow(
      SectionContentValidationError,
    );
    expect(() => validateSectionContent('unknown', {})).toThrow(
      'Unknown section type',
    );
  });

  it('preserves legacy modules and accepts optional stable slug and localized CTA', () => {
    const legacy = {
      items: [{ key: 'hrPayroll', bullets: ['Existing feature'] }],
    };
    expect(validateSectionContent('solutionModules', legacy)).toEqual(legacy);
    const content = {
      items: [
        {
          key: 'hrPayroll',
          slug: 'nhan-su-tien-luong',
          ctaLabel: 'View details',
          bullets: [],
        },
      ],
    };
    expect(validateSectionContent('solutionModules', content)).toEqual(content);
    expect(() =>
      validateSectionContent('solutionModules', {
        items: [{ ...content.items[0], slug: '../booking' }],
      }),
    ).toThrow('slug');
  });
});
