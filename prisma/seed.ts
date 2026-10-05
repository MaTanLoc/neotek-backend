import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type PageSeed = {
  slug: string;
  translations: Record<string, string>;
  sections: Array<{
    key: string;
    type: string;
    sortOrder: number;
  }>;
};

const pages: PageSeed[] = [
  {
    slug: 'home',
    translations: {
      vi: 'Trang chủ',
      en: 'Home',
    },
    sections: [
      { key: 'hero', type: 'hero', sortOrder: 10 },
      { key: 'why', type: 'why', sortOrder: 20 },
      { key: 'solutions', type: 'solutionOverview', sortOrder: 30 },
      { key: 'proofMetrics', type: 'proofMetrics', sortOrder: 40 },
      { key: 'trustedBy', type: 'trustedLogos', sortOrder: 50 },
      { key: 'solutionClusters', type: 'solutionClusters', sortOrder: 60 },
      { key: 'testimonials', type: 'testimonials', sortOrder: 70 },
      { key: 'cta', type: 'cta', sortOrder: 80 },
      { key: 'faq', type: 'faq', sortOrder: 90 },
    ],
  },
  {
    slug: 'solutions',
    translations: {
      vi: 'Giải pháp',
      en: 'Solutions',
    },
    sections: [
      { key: 'hero', type: 'hero', sortOrder: 10 },
      { key: 'groups', type: 'solutionGroups', sortOrder: 20 },
      { key: 'modules', type: 'solutionModules', sortOrder: 30 },
      { key: 'cta', type: 'cta', sortOrder: 40 },
      { key: 'faq', type: 'faq', sortOrder: 50 },
    ],
  },
];

async function seedPages(): Promise<void> {
  for (const pageSeed of pages) {
    const page = await prisma.page.upsert({
      where: { slug: pageSeed.slug },
      update: { status: 'DRAFT' },
      create: { slug: pageSeed.slug, status: 'DRAFT' },
    });

    for (const [locale, title] of Object.entries(pageSeed.translations)) {
      await prisma.pageTranslation.upsert({
        where: {
          pageId_locale: {
            pageId: page.id,
            locale,
          },
        },
        update: { title, seoTitle: null, seoDescription: null },
        create: {
          pageId: page.id,
          locale,
          title,
        },
      });
    }

    for (const sectionSeed of pageSeed.sections) {
      const section = await prisma.pageSection.upsert({
        where: {
          pageId_key: {
            pageId: page.id,
            key: sectionSeed.key,
          },
        },
        update: {
          type: sectionSeed.type,
          sortOrder: sectionSeed.sortOrder,
          enabled: true,
        },
        create: {
          pageId: page.id,
          key: sectionSeed.key,
          type: sectionSeed.type,
          sortOrder: sectionSeed.sortOrder,
          enabled: true,
        },
      });

      for (const locale of ['vi', 'en']) {
        await prisma.pageSectionTranslation.upsert({
          where: {
            sectionId_locale: {
              sectionId: section.id,
              locale,
            },
          },
          update: { content: {} },
          create: {
            sectionId: section.id,
            locale,
            content: {},
          },
        });
      }
    }
  }
}

async function seedSiteSettings(): Promise<void> {
  for (const key of ['site.navigation', 'site.footer']) {
    const setting = await prisma.siteSetting.upsert({
      where: { key },
      update: {},
      create: { key },
    });

    for (const locale of ['vi', 'en']) {
      await prisma.siteSettingTranslation.upsert({
        where: {
          settingId_locale: {
            settingId: setting.id,
            locale,
          },
        },
        update: { value: {} },
        create: {
          settingId: setting.id,
          locale,
          value: {},
        },
      });
    }
  }
}

async function main(): Promise<void> {
  await seedPages();
  await seedSiteSettings();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
