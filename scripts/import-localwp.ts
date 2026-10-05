import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import { validateSectionContent } from '../src/sections/validation/section-content.registry';
import {
  collectNumericMediaReferences,
  normalizeMigratedContent,
} from '../src/content/migrated-content.normalizer';

type Locale = 'vi' | 'en';
type SourcePost = {
  id: number;
  title: string;
  content: string;
  excerpt: string;
  status: string;
  slug: string;
  type: string;
  meta: Record<string, string>;
};

type ImportRecord = SourcePost & { locale: Locale; order: number };
type SectionContent = Record<string, unknown>;
type ImportPlan = {
  updates: Map<string, Map<Locale, SectionContent>>;
  counts: Record<string, number>;
  ambiguous: string[];
  missing: string[];
  skipped: string[];
  unresolvedMedia: string[];
};

const SOURCE_FILE = resolve(__dirname, '../migration-source/local.sql');
const LOCALES: Locale[] = ['vi', 'en'];
const PAGE_CACHE_KEYS = LOCALES.flatMap((locale) => [
  `cms:page:home:${locale}`,
  `cms:page:solutions:${locale}`,
]);
const REQUIRED_SECTIONS = {
  home: [
    'hero',
    'why',
    'solutions',
    'proofMetrics',
    'trustedBy',
    'solutionClusters',
    'testimonials',
    'cta',
    'faq',
  ],
  solutions: ['hero', 'groups', 'modules', 'cta', 'faq'],
};

function parseInsertValues(value: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === "'") {
      quoted = !quoted;
      continue;
    }
    if (character === ',' && !quoted) {
      values.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  values.push(current);
  return values.map((item) => (item === 'NULL' ? '' : item));
}

function readInsertStatements(sql: string, table: string): string[] {
  const statements: string[] = [];
  const prefix = `INSERT INTO \`${table}\` VALUES `;
  let position = 0;

  while ((position = sql.indexOf(prefix, position)) >= 0) {
    let cursor = position + prefix.length;
    let quoted = false;
    let escaped = false;

    for (; cursor < sql.length; cursor += 1) {
      const character = sql[cursor];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quoted && character === '\\') {
        escaped = true;
        continue;
      }
      if (character === "'") {
        quoted = !quoted;
        continue;
      }
      if (character === ';' && !quoted) {
        statements.push(sql.slice(position + prefix.length, cursor));
        position = cursor + 1;
        break;
      }
    }
  }

  return statements;
}

function parseSource(sql: string): SourcePost[] {
  const posts = new Map<number, Omit<SourcePost, 'meta'>>();
  const metadata = new Map<number, Record<string, string>>();

  for (const statement of readInsertStatements(sql, 'wp_posts')) {
    const values = parseInsertValues(statement.trim().slice(1, -1));
    const id = Number(values[0]);
    posts.set(id, {
      id,
      content: values[4],
      title: values[5],
      excerpt: values[6],
      status: values[7],
      slug: values[11],
      type: values[20],
    });
  }

  for (const statement of readInsertStatements(sql, 'wp_postmeta')) {
    const values = parseInsertValues(statement.trim().slice(1, -1));
    const postId = Number(values[1]);
    const postMeta = metadata.get(postId) ?? {};
    postMeta[values[2]] = values[3];
    metadata.set(postId, postMeta);
  }

  return [...posts.values()].map((post) => ({
    ...post,
    meta: metadata.get(post.id) ?? {},
  }));
}

function toBoolean(value: string | undefined): boolean {
  return value !== '0' && value !== 'false';
}

function toNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function localizedRecords(
  posts: SourcePost[],
  type: string,
  skipped: string[],
): ImportRecord[] {
  const records: ImportRecord[] = [];
  posts
    .filter((post) => post.type === type)
    .forEach((post, order) => {
      if (post.status !== 'publish' || !toBoolean(post.meta.is_active ?? post.meta.active)) {
        skipped.push(`${type}:${post.id}`);
        return;
      }
      const language = post.meta.language;
      if (!LOCALES.includes(language as Locale)) {
        skipped.push(`${type}:${post.id}:missing-locale`);
        return;
      }
      records.push({ ...post, locale: language as Locale, order });
    });

  return records.sort(
    (left, right) =>
      (toNumber(left.meta.display_order) ?? Number.MAX_SAFE_INTEGER) -
        (toNumber(right.meta.display_order) ?? Number.MAX_SAFE_INTEGER) ||
      left.order - right.order,
  );
}

function valueOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function buildContent(post: SourcePost, type: string): Record<string, unknown> {
  const meta = post.meta;
  let content: Record<string, unknown>;
  switch (type) {
    case 'hero_slide':
      content = {
        key: valueOrUndefined(meta.slide_key) ?? post.slug,
        desktopImage: valueOrUndefined(meta.image_url),
        mobileImage: valueOrUndefined(meta.mobile_image_url),
        imagePosition: valueOrUndefined(meta.image_position),
        mobileImagePosition: valueOrUndefined(meta.mobile_image_position),
        overlay: valueOrUndefined(meta.overlay),
        showContent: toBoolean(meta.show_content),
        contentPosition: valueOrUndefined(meta.content_position),
        eyebrow: valueOrUndefined(meta.eyebrow),
        headline: valueOrUndefined(meta.headline),
        description: valueOrUndefined(meta.description),
        primaryCta: {
          enabled: toBoolean(meta.show_primary_cta),
          label: valueOrUndefined(meta.primary_cta_label),
          url: valueOrUndefined(meta.primary_url),
        },
        secondaryCta: {
          enabled: toBoolean(meta.show_secondary_cta),
          label: valueOrUndefined(meta.secondary_label),
          url: valueOrUndefined(meta.secondary_url),
        },
      };
      break;
    case 'why_item':
      content = {
        key: post.slug,
        title: post.title,
        description: valueOrUndefined(post.content),
        icon: valueOrUndefined(meta.icon),
      };
      break;
    case 'proof_metric':
      content = {
        key: valueOrUndefined(meta.metric_key) ?? post.slug,
        value: toNumber(meta.value) ?? valueOrUndefined(meta.value),
        suffix: valueOrUndefined(meta.suffix),
        label: post.title,
      };
      break;
    case 'trusted_logo':
      content = {
        key: post.slug,
        url: valueOrUndefined(meta.logo_url),
        alt: valueOrUndefined(meta.alt_text) ?? post.title,
      };
      break;
    case 'solution_cluster':
      content = {
        key: valueOrUndefined(meta.cluster_key) ?? post.slug,
        title: post.title,
        description: valueOrUndefined(post.content),
        image: valueOrUndefined(meta.media_url),
      };
      break;
    case 'solution_module':
      content = {
        key: post.slug,
        title: post.title,
        description: valueOrUndefined(post.content),
        clusterKey: valueOrUndefined(meta.cluster_key),
      };
      break;
    case 'testimonial':
      content = {
        quote: valueOrUndefined(post.content),
        name: valueOrUndefined(meta.person_name) ?? post.title,
        role: valueOrUndefined(meta.role),
        company: valueOrUndefined(meta.organization),
        image: valueOrUndefined(meta.avatar),
      };
      break;
    case 'cta_section':
      content = {
        eyebrow: valueOrUndefined(meta.eyebrow),
        title: post.title,
        description: valueOrUndefined(post.content),
        primary: {
          label: valueOrUndefined(meta.primary_label),
          url: valueOrUndefined(meta.primary_url),
        },
        secondary: {
          label: valueOrUndefined(meta.secondary_label),
          url: valueOrUndefined(meta.secondary_url),
        },
      };
      break;
    case 'faq':
      content = {
        question: post.title,
        answer: post.content,
      };
      break;
    default:
      content = {};
  }
  return normalizeMigratedContent(content);
}

function addItems(
  plan: ImportPlan,
  page: 'home' | 'solutions',
  section: string,
  records: ImportRecord[],
  type: string,
): void {
  for (const locale of LOCALES) {
    const localeRecords = records.filter((record) => record.locale === locale);
    if (localeRecords.length === 0) {
      plan.missing.push(`${page}.${section}:${locale}`);
      continue;
    }
    const pageUpdates = plan.updates.get(page) ?? new Map();
    const existingSection = pageUpdates.get(locale)?.[section] as
      | { items?: SectionContent[]; slides?: SectionContent[] }
      | undefined;
    const newItems = localeRecords.map((record) => buildContent(record, type));
    pageUpdates.set(locale, {
      ...(pageUpdates.get(locale) ?? {}),
      [section]:
        section === 'hero'
          ? { slides: [...(existingSection?.slides ?? []), ...newItems] }
          : { items: [...(existingSection?.items ?? []), ...newItems] },
    });
    plan.updates.set(page, pageUpdates);
    plan.counts[`${page}.${section}.${locale}`] =
      (plan.counts[`${page}.${section}.${locale}`] ?? 0) + localeRecords.length;
  }
}

function addSharedItems(
  plan: ImportPlan,
  pages: Array<'home' | 'solutions'>,
  section: string,
  records: ImportRecord[],
  type: string,
): void {
  for (const page of pages) {
    addItems(plan, page, section, records, type);
  }
}

function normalizeWordPressData(posts: SourcePost[]): ImportPlan {
  const plan: ImportPlan = {
    updates: new Map(),
    counts: {},
    ambiguous: [],
    missing: [],
    skipped: [],
    unresolvedMedia: [],
  };

  addItems(plan, 'home', 'hero', localizedRecords(posts, 'hero_slide', plan.skipped), 'hero_slide');
  addItems(plan, 'home', 'why', localizedRecords(posts, 'why_item', plan.skipped), 'why_item');
  addItems(plan, 'home', 'proofMetrics', localizedRecords(posts, 'proof_metric', plan.skipped), 'proof_metric');
  addItems(
    plan,
    'home',
    'solutionClusters',
    localizedRecords(posts, 'solution_cluster', plan.skipped),
    'solution_cluster',
  );
  addItems(
    plan,
    'home',
    'solutionClusters',
    localizedRecords(posts, 'solution_module', plan.skipped),
    'solution_module',
  );
  addItems(plan, 'home', 'testimonials', localizedRecords(posts, 'testimonial', plan.skipped), 'testimonial');
  posts
    .filter((post) => post.type === 'testimonial')
    .forEach((post) => {
      const image = valueOrUndefined(post.meta.avatar);
      if (
        image &&
        collectNumericMediaReferences(image, '$.avatar').length > 0
      ) {
        plan.unresolvedMedia.push(`testimonial:${post.id}:avatar=${image}`);
      }
    });

  const trustedLogos = posts
    .filter(
      (post) =>
        post.type === 'trusted_logo' &&
        post.status === 'publish' &&
        toBoolean(post.meta.is_active ?? post.meta.active),
    )
    .map((post, order) => ({ ...post, locale: 'vi' as Locale, order }))
    .sort(
      (left, right) =>
        (toNumber(left.meta.display_order) ?? Number.MAX_SAFE_INTEGER) -
          (toNumber(right.meta.display_order) ?? Number.MAX_SAFE_INTEGER) ||
        left.order - right.order,
    );
  const inactiveTrustedLogos = posts.filter(
    (post) =>
      post.type === 'trusted_logo' &&
      (post.status !== 'publish' || !toBoolean(post.meta.is_active ?? post.meta.active)),
  );
  inactiveTrustedLogos.forEach((post) => plan.skipped.push(`trusted_logo:${post.id}`));
  const trustedContent = { items: trustedLogos.map((record) => buildContent(record, 'trusted_logo')) };
  const homeUpdates = plan.updates.get('home') ?? new Map<Locale, SectionContent>();
  for (const locale of LOCALES) {
    homeUpdates.set(locale, {
      ...(homeUpdates.get(locale) ?? {}),
      trustedBy: trustedContent,
    });
    plan.counts[`home.trustedBy.${locale}`] = trustedLogos.length;
  }
  plan.updates.set('home', homeUpdates);

  addSharedItems(
    plan,
    ['home', 'solutions'],
    'cta',
    localizedRecords(posts, 'cta_section', plan.skipped),
    'cta_section',
  );
  addSharedItems(
    plan,
    ['home', 'solutions'],
    'faq',
    localizedRecords(posts, 'faq', plan.skipped),
    'faq',
  );

  for (const type of ['sol_page_group', 'sol_page_module']) {
    const count = posts.filter((post) => post.type === type).length;
    if (count === 0) {
      plan.missing.push(`${type}:no source records`);
    }
  }

  return plan;
}

async function validateTargetStructure(prisma: PrismaClient): Promise<void> {
  for (const [slug, keys] of Object.entries(REQUIRED_SECTIONS)) {
    const page = await prisma.page.findUnique({
      where: { slug },
      include: { sections: { select: { key: true } } },
    });
    if (!page) {
      throw new Error(`Required target page is missing: ${slug}`);
    }
    const actual = new Set(page.sections.map((section) => section.key));
    const missing = keys.filter((key) => !actual.has(key));
    if (missing.length > 0) {
      throw new Error(`Required target sections missing for ${slug}: ${missing.join(', ')}`);
    }
  }
}

async function applyImport(prisma: PrismaClient, plan: ImportPlan): Promise<string[]> {
  const updated: string[] = [];
  await prisma.$transaction(async (transaction) => {
    for (const [pageSlug, locales] of plan.updates) {
      const page = await transaction.page.findUnique({ where: { slug: pageSlug } });
      if (!page) {
        throw new Error(`Required target page is missing: ${pageSlug}`);
      }
      for (const [locale, sections] of locales) {
        for (const [sectionKey, content] of Object.entries(sections)) {
          const section = await transaction.pageSection.findUnique({
            where: { pageId_key: { pageId: page.id, key: sectionKey } },
          });
          if (!section) {
            throw new Error(`Required target section is missing: ${pageSlug}.${sectionKey}`);
          }
          const jsonContent = JSON.parse(JSON.stringify(content)) as Prisma.InputJsonValue;
          await transaction.pageSectionTranslation.update({
            where: { sectionId_locale: { sectionId: section.id, locale } },
            data: { content: jsonContent },
          });
          updated.push(`${pageSlug}.${sectionKey}.${locale}`);
        }
      }
    }
  });
  return updated;
}

function printSummary(plan: ImportPlan, dryRun: boolean): void {
  console.log(dryRun ? 'LocalWP import dry-run' : 'LocalWP import applied');
  console.log('Counts:', JSON.stringify(plan.counts));
  console.log(`Ambiguous: ${plan.ambiguous.length}`);
  plan.ambiguous.forEach((item) => console.log(`  - ${item}`));
  console.log(`Missing: ${plan.missing.length}`);
  plan.missing.forEach((item) => console.log(`  - ${item}`));
  console.log(`Skipped: ${plan.skipped.length}`);
  console.log(`Unresolved media: ${plan.unresolvedMedia.length}`);
}

function validateImportPlan(plan: ImportPlan): void {
  const sectionTypes: Record<string, string> = {
    hero: 'hero',
    why: 'why',
    proofMetrics: 'proofMetrics',
    trustedBy: 'trustedLogos',
    solutionClusters: 'solutionClusters',
    testimonials: 'testimonials',
    cta: 'cta',
    faq: 'faq',
  };

  for (const locales of plan.updates.values()) {
    for (const sections of locales.values()) {
      for (const [sectionKey, content] of Object.entries(sections)) {
        const sectionType = sectionTypes[sectionKey];
        if (sectionType) {
          validateSectionContent(sectionType, content);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const dryRun =
    process.argv.includes('--dry-run') || process.env.npm_config_dry_run === 'true';
  const prisma = new PrismaClient();

  try {
    const source = readFileSync(SOURCE_FILE, 'utf8');
    const plan = normalizeWordPressData(parseSource(source));
    validateImportPlan(plan);
    await validateTargetStructure(prisma);
    printSummary(plan, dryRun);

    if (dryRun) {
      return;
    }

    const updated = await applyImport(prisma, plan);
    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
    for (const key of PAGE_CACHE_KEYS) {
      await redis.del(key);
    }
    await redis.quit();
    console.log(`Updated sections: ${updated.length}`);
    console.log(`Cache keys invalidated: ${PAGE_CACHE_KEYS.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export {
  buildContent,
  normalizeWordPressData,
  parseSource,
  type ImportPlan,
  type SourcePost,
};
