/* eslint-disable no-control-regex -- URL guards intentionally reject control characters. */
import { URL } from 'node:url';
import { z } from 'zod';

export const detailSlugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine(
    (value) =>
      ![
        'home',
        'solutions',
        'booking',
        'login',
        'register',
        'solution-details',
      ].includes(value),
    'Reserved slug',
  );
export const safeDestination = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
    if (value.startsWith('/') && !value.startsWith('//')) return true;
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, 'Use an internal path or http/https URL');
export const safeImage = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    if (
      value.startsWith('/assets/') &&
      !/[\\\s\u0000-\u001f]/.test(value) &&
      !value.includes('..')
    )
      return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        url.hostname === 'res.cloudinary.com' &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, 'Use a project asset or Cloudinary image');
const copy = z.string().max(12000);
const ctaAttrs = z
  .object({
    id: z.string().max(120),
    title: copy,
    description: copy,
    label: copy,
    url: safeDestination,
    style: z.enum(['primary', 'secondary']).default('primary'),
    placement: z.enum(['inline', 'final']).default('inline'),
  })
  .strict();
const markSchema = z.union([
  z.object({ type: z.enum(['bold', 'italic']) }).strict(),
  z
    .object({
      type: z.literal('link'),
      attrs: z
        .object({
          href: safeDestination.refine((value) => !!value),
          target: z.enum(['_blank', '_self']).nullable().optional(),
          rel: z.string().max(100).nullable().optional(),
          class: z.null().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type ArticleNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: unknown[];
  content?: ArticleNode[];
};
export const articleNodeSchema: z.ZodType<ArticleNode> = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal('text'),
        text: z.string().min(1).max(50000),
        marks: z.array(markSchema).max(3).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('paragraph'),
        content: z.array(articleNodeSchema).max(1000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('heading'),
        attrs: z
          .object({
            level: z.union([z.literal(2), z.literal(3)]),
            id: z.string().max(120).nullable().optional(),
          })
          .strict(),
        content: z.array(articleNodeSchema).max(1000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.enum(['bulletList', 'listItem', 'blockquote']),
        content: z.array(articleNodeSchema).min(1).max(1000),
      })
      .strict(),
    z
      .object({
        type: z.literal('orderedList'),
        attrs: z
          .object({
            start: z.number().int().min(1).max(10000).default(1),
            type: z.null().optional(),
          })
          .strict()
          .optional(),
        content: z.array(articleNodeSchema).min(1).max(1000),
      })
      .strict(),
    z.object({ type: z.enum(['horizontalRule', 'hardBreak']) }).strict(),
    z
      .object({
        type: z.literal('articleImage'),
        attrs: z
          .object({
            id: z.string().max(120),
            src: safeImage.refine((value) => !!value),
            alt: copy,
            caption: copy,
            display: z.enum(['normal', 'wide', 'full']),
          })
          .strict(),
      })
      .strict(),
    z.object({ type: z.literal('articleCta'), attrs: ctaAttrs }).strict(),
    z
      .object({
        type: z.literal('callout'),
        attrs: z
          .object({ variant: z.enum(['info', 'success', 'warning']) })
          .strict(),
        content: z.array(articleNodeSchema).min(1).max(1000),
      })
      .strict(),
  ]),
);
function withinLimits(value: unknown): boolean {
  let count = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (++count > 5000 || depth > 12 || !node || typeof node !== 'object')
      return false;
    const item = node as ArticleNode;
    return (
      !item.content ||
      (Array.isArray(item.content) &&
        item.content.every((child) => visit(child, depth + 1)))
    );
  };
  return JSON.stringify(value).length <= 1000000 && visit(value, 0);
}
const boundedDoc = z
  .unknown()
  .refine(withinLimits, 'Article exceeds document size/depth limits')
  .pipe(
    z
      .object({
        type: z.literal('doc'),
        content: z.array(articleNodeSchema).max(1000),
      })
      .strict(),
  );
export const solutionArticleSchema = z
  .object({ version: z.literal(1), doc: boundedDoc })
  .strict()
  .superRefine((value, ctx) => {
    const inline = new Set(['text', 'hardBreak']);
    const ids = new Set<string>();
    const headingIds = new Set<string>();
    const visit = (node: ArticleNode) => {
      const children = node.content || [];
      if (node.type === 'heading' && node.attrs?.id) {
        const id = String(node.attrs.id);
        if (headingIds.has(id))
          ctx.addIssue({
            code: 'custom',
            message: 'Heading identifiers must be unique',
          });
        headingIds.add(id);
      }
      if (
        ['paragraph', 'heading'].includes(node.type) &&
        children.some((child) => !inline.has(child.type))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Paragraphs/headings contain inline text only',
        });
      if (
        ['bulletList', 'orderedList'].includes(node.type) &&
        children.some((child) => child.type !== 'listItem')
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Lists contain list items only',
        });
      if (node.type === 'listItem' && children[0]?.type !== 'paragraph')
        ctx.addIssue({
          code: 'custom',
          message: 'List items start with a paragraph',
        });
      if (
        ['doc', 'blockquote', 'callout', 'listItem'].includes(node.type) &&
        children.some(
          (child) => inline.has(child.type) || child.type === 'listItem',
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid block structure' });
      if (['articleImage', 'articleCta'].includes(node.type)) {
        const id = String(node.attrs?.id || '');
        if (!id || ids.has(id))
          ctx.addIssue({
            code: 'custom',
            message: 'Media/CTA identifiers must be unique',
          });
        ids.add(id);
      }
      children.forEach(visit);
    };
    visit(value.doc);
  });
export const solutionDetailHeroSchema = z
  .object({
    eyebrow: copy,
    title: copy,
    description: copy,
    cover: safeImage,
    alt: copy,
    cta: z.object({ label: copy, url: safeDestination }).strict(),
    ogImage: safeImage,
  })
  .strict();
export const relatedSolutionsSchema = z
  .object({
    moduleKeys: z
      .array(z.string().min(1).max(120))
      .max(12)
      .refine((value) => new Set(value).size === value.length),
  })
  .strict();
export const emptyArticle = () => ({
  version: 1 as const,
  doc: { type: 'doc', content: [{ type: 'paragraph' }] },
});
export const emptyDetailHero = (title = '') => ({
  eyebrow: '',
  title,
  description: '',
  cover: '',
  alt: '',
  cta: { label: '', url: '' },
  ogImage: '',
});
export function articleText(node: ArticleNode): string {
  return [node.text || '', ...(node.content || []).map(articleText)]
    .join(' ')
    .trim();
}

const detailLocaleSchema = z
  .object({
    title: copy,
    seoTitle: z.string().max(200).nullable(),
    seoDescription: z.string().max(500).nullable(),
    hero: solutionDetailHeroSchema,
    article: solutionArticleSchema,
  })
  .strict();
export const detailSaveSchema = z
  .object({
    slug: detailSlugSchema,
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
    visible: z.boolean(),
    publishedAt: z.string().datetime().nullable().optional(),
    related: relatedSolutionsSchema,
    translations: z
      .object({ vi: detailLocaleSchema, en: detailLocaleSchema })
      .strict(),
  })
  .strict();
