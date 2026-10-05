import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import {
  collectNumericMediaReferences,
  normalizeMigratedContent,
} from '../src/content/migrated-content.normalizer';
import { validateSectionContent } from '../src/sections/validation/section-content.registry';

const TARGET_PAGES = ['home', 'solutions'] as const;
const TARGET_CACHE_PREFIX = 'cms:page:';

type CleanupRecord = {
  page: string;
  locale: string;
  section: string;
  sectionType: string;
  content: Prisma.JsonValue;
};

type CleanupChange = CleanupRecord & {
  normalized: Prisma.JsonValue;
  valueCount: number;
  sample?: { before: string; after: string };
};

function countChangedStrings(before: unknown, after: unknown): number {
  if (typeof before === 'string' && typeof after === 'string') {
    return before === after ? 0 : 1;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.reduce(
      (count, item, index) =>
        count + countChangedStrings(item, after[index]),
      0,
    );
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object'
  ) {
    return Object.keys(before).reduce(
      (count, key) =>
        count +
        countChangedStrings(
          (before as Record<string, unknown>)[key],
          (after as Record<string, unknown>)[key],
        ),
      0,
    );
  }
  return 0;
}

function firstChangedSample(
  before: unknown,
  after: unknown,
): { before: string; after: string } | undefined {
  if (typeof before === 'string' && typeof after === 'string') {
    return before === after
      ? undefined
      : { before: before.slice(0, 180), after: after.slice(0, 180) };
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    for (let index = 0; index < before.length; index += 1) {
      const sample = firstChangedSample(before[index], after[index]);
      if (sample) return sample;
    }
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object'
  ) {
    for (const key of Object.keys(before)) {
      const sample = firstChangedSample(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
      );
      if (sample) return sample;
    }
  }
  return undefined;
}

export function planCleanup(records: CleanupRecord[]): CleanupChange[] {
  return records.flatMap((record) => {
    const normalized = normalizeMigratedContent(record.content);
    if (JSON.stringify(normalized) === JSON.stringify(record.content)) return [];
    return [
      {
        ...record,
        normalized,
        valueCount: countChangedStrings(record.content, normalized),
        sample: firstChangedSample(record.content, normalized),
      },
    ];
  });
}

function isApplyMode(): boolean {
  return process.argv.includes('--apply');
}

export function getAffectedCacheKeys(changes: CleanupChange[]): string[] {
  return [
    ...new Set(
      changes.map(
        (change) => `${TARGET_CACHE_PREFIX}${change.page}:${change.locale}`,
      ),
    ),
  ];
}

function printChanges(changes: CleanupChange[]): void {
  for (const change of changes) {
    console.log(
      `${change.page}.${change.section}.${change.locale}: ${change.valueCount} value(s)`,
    );
    if (change.sample) {
      console.log(`  before: ${change.sample.before}`);
      console.log(`  after:  ${change.sample.after}`);
    }
  }
}

async function invalidateCaches(changes: CleanupChange[]): Promise<void> {
  const keys = getAffectedCacheKeys(changes);
  if (keys.length === 0) return;

  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    for (const key of keys) await redis.del(key);
    console.log(`Cache keys invalidated: ${keys.join(', ')}`);
  } catch (error) {
    console.error(
      `Cache invalidation failed after database commit: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (redis.isOpen) await redis.quit();
  }
}

async function main(): Promise<void> {
  const apply = isApplyMode();
  const prisma = new PrismaClient();

  try {
    const translations = await prisma.pageSectionTranslation.findMany({
      where: { section: { page: { slug: { in: [...TARGET_PAGES] } } } },
      select: {
        locale: true,
        content: true,
        section: {
          select: {
            key: true,
            type: true,
            page: { select: { slug: true } },
          },
        },
      },
      orderBy: [{ section: { page: { slug: 'asc' } } }, { section: { key: 'asc' } }, { locale: 'asc' }],
    });

    const records: CleanupRecord[] = translations.map((translation) => ({
      page: translation.section.page.slug,
      locale: translation.locale,
      section: translation.section.key,
      sectionType: translation.section.type,
      content: translation.content,
    }));
    const changes = planCleanup(records);
    const unresolved = records.flatMap((record) =>
      record.section === 'testimonials'
        ? collectNumericMediaReferences(record.content).map((reference) => ({
            ...record,
            ...reference,
          }))
        : [],
    );

    console.log(apply ? 'Migrated content cleanup apply' : 'Migrated content cleanup dry-run');
    console.log(`Records audited: ${records.length}`);
    console.log(`Records requiring normalization: ${changes.length}`);
    console.log(`Values requiring normalization: ${changes.reduce((sum, change) => sum + change.valueCount, 0)}`);
    printChanges(changes);
    console.log(`Unresolved media references: ${unresolved.length}`);
    unresolved.forEach((reference) =>
      console.log(
        `  - ${reference.page}.${reference.section}.${reference.locale} ${reference.path} = ${reference.value}`,
      ),
    );

    if (!apply || changes.length === 0) return;

    await prisma.$transaction(async (transaction) => {
      for (const change of changes) {
        validateSectionContent(change.sectionType, change.normalized);
        const page = await transaction.page.findUnique({
          where: { slug: change.page },
          select: { id: true },
        });
        if (!page) throw new Error(`Page not found: ${change.page}`);
        const section = await transaction.pageSection.findUnique({
          where: { pageId_key: { pageId: page.id, key: change.section } },
          select: { id: true },
        });
        if (!section) throw new Error(`Section not found: ${change.page}.${change.section}`);
        await transaction.pageSectionTranslation.update({
          where: { sectionId_locale: { sectionId: section.id, locale: change.locale } },
          data: { content: change.normalized as Prisma.InputJsonValue },
        });
      }
    });

    console.log(`Records updated: ${changes.length}`);
    await invalidateCaches(changes);
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

export { countChangedStrings };
