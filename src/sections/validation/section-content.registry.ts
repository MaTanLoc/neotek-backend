import { z } from 'zod';

const optionalText = z.string().nullable().optional();

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
    desktopImage: optionalText,
    mobileImage: optionalText,
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

const whyContentSchema = z.object({ items: z.array(whyItemSchema) }).strict();

const proofMetricSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    value: z.union([z.number(), z.string()]),
    suffix: optionalText,
  })
  .strict();

const proofMetricsContentSchema = z
  .object({ items: z.array(proofMetricSchema) })
  .strict();

const trustedLogoSchema = z
  .object({
    key: z.string(),
    alt: z.string(),
    url: optionalText,
  })
  .strict();

const trustedLogosContentSchema = z
  .object({ items: z.array(trustedLogoSchema) })
  .strict();

const solutionItemSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    description: optionalText,
    image: optionalText,
    clusterKey: optionalText,
  })
  .strict();

const solutionClustersContentSchema = z
  .object({ items: z.array(solutionItemSchema) })
  .strict();

const testimonialSchema = z
  .object({
    quote: optionalText,
    name: z.string(),
    role: optionalText,
    company: optionalText,
    image: optionalText,
  })
  .strict();

const testimonialsContentSchema = z
  .object({ items: z.array(testimonialSchema) })
  .strict();

const ctaSectionSchema = z
  .object({
    eyebrow: optionalText,
    title: z.string(),
    description: optionalText,
    primary: ctaActionSchema.omit({ enabled: true }),
    secondary: ctaActionSchema.omit({ enabled: true }),
  })
  .strict();

const ctaContentSchema = z
  .object({ items: z.array(ctaSectionSchema) })
  .strict();

const faqItemSchema = z
  .object({
    question: z.string(),
    answer: z.string(),
  })
  .strict();

const faqContentSchema = z.object({ items: z.array(faqItemSchema) }).strict();

const emptyObjectContentSchema = z.record(z.string(), z.unknown());

export const sectionContentSchemas = {
  hero: heroContentSchema,
  why: whyContentSchema,
  solutionOverview: emptyObjectContentSchema,
  proofMetrics: proofMetricsContentSchema,
  trustedLogos: trustedLogosContentSchema,
  solutionClusters: solutionClustersContentSchema,
  testimonials: testimonialsContentSchema,
  cta: ctaContentSchema,
  faq: faqContentSchema,
  solutionGroups: emptyObjectContentSchema,
  solutionModules: emptyObjectContentSchema,
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
    Object.keys(content).length === 0
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
};
