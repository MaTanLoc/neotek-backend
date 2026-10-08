import { sanitizeFaqHtml, sanitizePublicFaqContent } from './public-html';

describe('public FAQ sanitizer', () => {
  it('preserves paragraphs, emphasis, lists and safe links', () => {
    const html =
      '<p>Hello <strong>team</strong> <em>today</em></p><ul><li>One</li></ul><ol><li>Two</li></ol><a href="https://neotek.vn">Read</a>';
    expect(sanitizeFaqHtml(html)).toBe(html);
  });
  it.each([
    '<script>alert(1)</script><p>Safe</p>',
    '<p onclick="alert(1)">Safe</p>',
    '<a href="javascript:alert(1)">Safe</a>',
    '<a href="java&#x73;cript:alert(1)">Safe</a>',
    '<iframe src="https://evil.example">Hidden</iframe><p>Safe</p>',
    '<svg><foreignObject><p onclick="alert(1)">Hidden</p></foreignObject></svg><p>Safe</p>',
  ])('removes executable HTML: %s', (html) => {
    expect(sanitizeFaqHtml(html)).not.toMatch(
      /script|onclick|javascript|iframe|svg|Hidden|alert/,
    );
    expect(sanitizeFaqHtml(html)).toContain('Safe');
  });
  it('does not mutate stored content', () => {
    const original = {
      items: [{ key: 'a', answer: '<p onclick="bad()">Safe</p>' }],
    };
    expect(sanitizePublicFaqContent(original)).toEqual({
      items: [{ key: 'a', answer: '<p>Safe</p>' }],
    });
    expect(original.items[0].answer).toContain('onclick');
  });
});
