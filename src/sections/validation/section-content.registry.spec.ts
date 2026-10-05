import {
  SectionContentValidationError,
  validateSectionContent,
} from './section-content.registry';

describe('section content registry', () => {
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
});
