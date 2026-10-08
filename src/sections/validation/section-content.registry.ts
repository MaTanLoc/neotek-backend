import { z } from 'zod';
import { isSafeContentUrl } from './content-urls';
import {
  solutionDetailHeroSchema,
  solutionArticleSchema,
  relatedSolutionsSchema,
  contentWithinLimits,
} from './solution-detail.schemas';

const optionalText = z.string().max(12000).nullable().optional();
const optionalMedia = z
  .string()
  .max(2048)
  .refine(
    (value) => isSafeContentUrl(value, true),
    'Use HTTPS or a project path',
  )
  .nullable()
  .optional();
const sectionCopy = {
  eyebrow: optionalText,
  title: optionalText,
  titleHighlight: optionalText,
  description: optionalText,
  ctaLabel: optionalText,
  ctaUrl: optionalText,
  actions: z
    .array(
      z
        .object({
          key: z.string(),
          label: z.string(),
          url: optionalText,
          variant: z.enum(['primary', 'secondary', 'ghost']).optional(),
        })
        .strict(),
    )
    .optional(),
};

const ctaActionSchema = z
  .object({
    enabled: z.boolean().optional(),
    label: optionalText,
    url: optionalText,
  })
  .strict();

const heroSlideSchema = z
  .object({
    key: z.string(),
    desktopImage: optionalMedia,
    mobileImage: optionalMedia,
    imagePosition: optionalText,
    mobileImagePosition: optionalText,
    overlay: optionalText,
    showContent: z.boolean(),
    contentPosition: optionalText,
    eyebrow: optionalText,
    headline: optionalText,
    description: optionalText,
    primaryCta: ctaActionSchema,
    secondaryCta: ctaActionSchema,
    titleLine1: optionalText,
    titleHighlight: optionalText,
  })
  .strict();

const heroContentSchema = z
  .object({ slides: z.array(heroSlideSchema) })
  .strict();

const whyItemSchema = z
  .object({
    key: z.string(),
    icon: optionalText,
    title: z.string(),
    description: optionalText,
  })
  .strict();

const whyContentSchema = z
  .object({ ...sectionCopy, items: z.array(whyItemSchema) })
  .strict();

const proofMetricSchema = z
  .object({
    key: z.string(),
    subtitle: optionalText,
    label: z.string(),
    value: z.union([z.number(), z.string()]),
    suffix: optionalText,
  })
  .strict();

const proofMetricsContentSchema = z
  .object({ ...sectionCopy, items: z.array(proofMetricSchema) })
  .strict();

const trustedLogoSchema = z
  .object({
    key: z.string(),
    alt: z.string(),
    width: z.number().min(1).max(800).optional(),
    maxWidth: z.number().min(1).max(800).optional(),
    height: z.number().min(1).max(800).optional(),
    scale: z.number().min(0.25).max(3).optional(),
    objectFit: z.enum(['contain', 'cover']).optional(),
    url: optionalMedia,
  })
  .strict();

const trustedLogosContentSchema = z
  .object({ ...sectionCopy, items: z.array(trustedLogoSchema) })
  .strict();

const solutionItemSchema = z
  .object({
    key: z.string(),
    label: optionalText,
    title: z.string(),
    description: optionalText,
    image: optionalMedia,
    clusterKey: optionalText,
  })
  .strict();

const solutionClustersContentSchema = z
  .object({ ...sectionCopy, items: z.array(solutionItemSchema) })
  .strict();

const testimonialSchema = z
  .object({
    key: z.string().optional(),
    quote: optionalText,
    name: z.string(),
    role: optionalText,
    company: optionalText,
    image: optionalMedia,
    focalX: z.number().min(0).max(100).optional(),
    focalY: z.number().min(0).max(100).optional(),
    zoom: z.number().min(1).max(2.5).optional(),
  })
  .strict();

const testimonialsContentSchema = z
  .object({ ...sectionCopy, items: z.array(testimonialSchema) })
  .strict();

const ctaSectionSchema = z
  .object({
    eyebrow: optionalText,
    title: z.string(),
    description: optionalText,
    primary: ctaActionSchema.extend({
      variant: z.enum(['primary', 'secondary', 'ghost']).optional(),
    }),
    secondary: ctaActionSchema.extend({
      variant: z.enum(['primary', 'secondary', 'ghost']).optional(),
    }),
  })
  .strict();

const ctaContentSchema = z
  .object({ items: z.array(ctaSectionSchema) })
  .strict();

const faqItemSchema = z
  .object({
    key: z.string().optional(),
    question: z.string(),
    answer: z.string(),
  })
  .strict();

const faqContentSchema = z
  .object({ ...sectionCopy, items: z.array(faqItemSchema) })
  .strict();

const solutionGroupSchema = z
  .object({
    key: z.string(),
    icon: optionalText,
    modules: z.array(z.string()),
    eyebrow: optionalText,
    title: optionalText,
    description: optionalText,
    visualLabel: optionalText,
    visualSrc: optionalMedia,
  })
  .strict();

const solutionGroupsContentSchema = z
  .object({ ...sectionCopy, items: z.array(solutionGroupSchema) })
  .strict();

const solutionModuleSchema = z
  .object({
    key: z.string(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .or(z.literal(''))
      .optional(),
    ctaLabel: optionalText,
    icon: optionalText,
    visualSrc: optionalMedia,
    title: optionalText,
    description: optionalText,
    bullets: z.array(z.string()),
  })
  .strict();

const solutionModulesContentSchema = z
  .object({ ...sectionCopy, items: z.array(solutionModuleSchema) })
  .strict();

const solutionOverviewContentSchema = z
  .object({
    ...sectionCopy,
    items: z
      .array(
        z
          .object({
            key: z.string(),
            title: z.string(),
            description: optionalText,
            image: optionalMedia,
            imagePosition: optionalText,
            modules: z.array(
              z
                .object({
                  key: z.string(),
                  title: z.string(),
                  icon: optionalText,
                  url: optionalText,
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const sectionContentSchemas = {
  solutionDetailHero: solutionDetailHeroSchema,
  solutionArticle: solutionArticleSchema,
  relatedSolutions: relatedSolutionsSchema,
  hero: heroContentSchema,
  why: whyContentSchema,
  solutionOverview: solutionOverviewContentSchema,
  proofMetrics: proofMetricsContentSchema,
  trustedLogos: trustedLogosContentSchema,
  solutionClusters: solutionClustersContentSchema,
  testimonials: testimonialsContentSchema,
  cta: ctaContentSchema,
  faq: faqContentSchema,
  solutionGroups: solutionGroupsContentSchema,
  solutionModules: solutionModulesContentSchema,
} as const;

export type SectionType = keyof typeof sectionContentSchemas;
export type ValidatedSectionContent = z.infer<
  (typeof sectionContentSchemas)[SectionType]
>;

export function isRegisteredSectionType(type: string): type is SectionType {
  return Object.prototype.hasOwnProperty.call(sectionContentSchemas, type);
}

export class SectionContentValidationError extends Error {
  constructor(
    public readonly sectionType: string,
    public readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(
      `Invalid content for section type "${sectionType}": ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'SectionContentValidationError';
  }
}

export function validateSectionContent(
  sectionType: string,
  content: unknown,
): ValidatedSectionContent {
  if (!contentWithinLimits(content))
    throw new SectionContentValidationError(sectionType, [
      { path: '$', message: 'Content nesting or size exceeds allowed limits' },
    ]);
  if (!isRegisteredSectionType(sectionType)) {
    throw new SectionContentValidationError(sectionType, [
      { path: '$', message: 'Unknown section type' },
    ]);
  }
  const schema = sectionContentSchemas[sectionType];

  if (
    content !== null &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    Object.keys(content).length === 0 &&
    !['solutionDetailHero', 'solutionArticle', 'relatedSolutions'].includes(
      sectionType,
    )
  ) {
    return content as ValidatedSectionContent;
  }

  const result = schema.safeParse(content);
  if (!result.success) {
    throw new SectionContentValidationError(
      sectionType,
      result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '$',
        message: issue.message,
      })),
    );
  }

  return result.data as ValidatedSectionContent;
}

export {
  ctaContentSchema,
  faqContentSchema,
  heroContentSchema,
  proofMetricsContentSchema,
  solutionClustersContentSchema,
  testimonialsContentSchema,
  trustedLogosContentSchema,
  whyContentSchema,
  solutionGroupsContentSchema,
  solutionModulesContentSchema,
};
