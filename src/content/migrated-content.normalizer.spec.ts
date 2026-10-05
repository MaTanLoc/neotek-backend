import {
  collectNumericMediaReferences,
  normalizeMigratedContent,
  normalizeMigratedString,
} from './migrated-content.normalizer';

describe('migrated content normalizer', () => {
  it('removes WordPress wrappers and literal n separators', () => {
    expect(
      normalizeMigratedString(
        '<!-- wp:paragraph -->n<p>Answer &amp; detail.</p>n<!-- /wp:paragraph -->',
      ),
    ).toBe('<p>Answer &amp; detail.</p>');
  });

  it('preserves FAQ paragraph HTML and plain text', () => {
    expect(normalizeMigratedString('<p>Answer</p>')).toBe('<p>Answer</p>');
    expect(normalizeMigratedString('Plain text.')).toBe('Plain text.');
  });

  it('is idempotent and normalizes recursively', () => {
    const value = {
      items: [
        {
          answer: '<!-- wp:paragraph -->n<p>One</p>n<!-- /wp:paragraph -->',
          image: '51',
        },
      ],
    };
    const normalized = normalizeMigratedContent(value);
    expect(normalized).toEqual({
      items: [{ answer: '<p>One</p>', image: '51' }],
    });
    expect(normalizeMigratedContent(normalized)).toEqual(normalized);
    expect(collectNumericMediaReferences(normalized)).toEqual([
      { path: '$.items[0].image', value: '51' },
    ]);
  });
});
