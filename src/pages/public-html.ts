import sanitizeHtml = require('sanitize-html');

// Only public FAQ delivery is normalized; persisted/admin content stays intact.
export function sanitizeFaqHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'div',
      'strong',
      'b',
      'em',
      'i',
      'ul',
      'ol',
      'li',
      'a',
    ],
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowProtocolRelative: false,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'iframe',
      'object',
      'embed',
      'svg',
      'math',
    ],
  });
}

export function sanitizePublicFaqContent(content: object): object {
  const value = content as { items?: Array<Record<string, unknown>> };
  return {
    ...value,
    ...(Array.isArray(value.items)
      ? {
          items: value.items.map((item) => ({
            ...item,
            ...(typeof item.answer === 'string'
              ? { answer: sanitizeFaqHtml(item.answer) }
              : {}),
          })),
        }
      : {}),
  };
}
