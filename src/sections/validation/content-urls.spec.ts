import { isSafeContentUrl, safePublicMedia } from './content-urls';
import { validateSectionContent } from './section-content.registry';

describe('CMS media URL boundary', () => {
  it('preserves custom icon filenames while rejecting unsafe icon references', () => {
    const icon = 'neotek-shopping-basket-03-stroke-rounded.svg';
    const content = {
      items: [
        { icon },
        { icon: 'javascript:alert(1)' },
        { icon: '../outside.svg' },
      ],
    };
    expect(safePublicMedia(content)).toEqual({
      items: [{ icon }, { icon: null }, { icon: null }],
    });
    expect(content.items[0].icon).toBe(icon);
  });
  it.each([
    'javascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:image/svg+xml,<svg/>',
    '//evil.example/image',
    '/\\evil.example/image',
  ])('rejects unsafe media %s', (value) => {
    expect(isSafeContentUrl(value, true)).toBe(false);
    expect(() =>
      validateSectionContent('testimonials', {
        items: [{ name: 'Customer', image: value }],
      }),
    ).toThrow();
  });
  it('preserves Cloudinary, local images and geometry; strips persisted unsafe URLs without mutation', () => {
    const content = {
      items: [
        {
          url: 'https://res.cloudinary.com/demo/image/upload/a.png',
          width: 160,
          scale: 1.2,
        },
        { url: 'javascript:alert(1)' },
      ],
    };
    expect(safePublicMedia(content, true)).toEqual({
      items: [content.items[0], { url: null }],
    });
    expect(content.items[1].url).toBe('javascript:alert(1)');
    expect(isSafeContentUrl('/assets/logo.png', true)).toBe(true);
  });
});
