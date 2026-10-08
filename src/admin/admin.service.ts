import {
  resolveSharedTranslations,
  sharedSource,
  sharedConsumers,
} from '../sections/shared-content';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PageKind, PageStatus, Prisma, UserRole } from '@prisma/client';
import {
  createSolutionDetail,
  detailAvailability,
  solutionModules,
} from '../pages/solution-detail';
import {
  detailSaveSchema,
  articleText,
  contentWithinLimits,
} from '../sections/validation/solution-detail.schemas';
import { PageCacheInvalidationService } from '../cache/page-cache-invalidation.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SectionContentValidationError,
  isRegisteredSectionType,
  validateSectionContent,
} from '../sections/validation/section-content.registry';
import { SafeUser } from '../auth/auth.types';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALE_PATTERN = /^[a-z]{2}(?:-[a-z]{2})?$/;

@Injectable()
export class AdminService {
  private readonly prisma: PrismaService;
  private readonly pageCache: PageCacheInvalidationService;

  constructor(prisma: PrismaService, pageCache: PageCacheInvalidationService) {
    this.prisma = prisma;
    this.pageCache = pageCache;
  }

  listSolutionDetails() {
    return detailAvailability(this.prisma);
  }

  async getSolutionDetail(slug: string) {
    const page = await this.getPage(slug);
    if (page.kind !== PageKind.SOLUTION_DETAIL)
      throw new NotFoundException('Solution detail not found');
    return page;
  }

  async createSolutionDetail(input: unknown) {
    const body = this.object(input);
    this.assertKeys(body, ['moduleKey']);
    const moduleKey = this.text(body.moduleKey, 'Module');
    try {
      return await this.prisma.$transaction(
        (tx) => createSolutionDetail(tx, moduleKey),
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      this.uniqueConflict(error, 'Detail slug already exists');
    }
  }

  async saveSolutionDetail(id: string, input: unknown) {
    if (!contentWithinLimits(input))
      throw new BadRequestException(
        'Content nesting or size exceeds allowed limits',
      );
    const parsed = detailSaveSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(
        parsed.error.issues.map(
          (issue) => `${issue.path.join('.')}: ${issue.message}`,
        ),
      );
    const body = parsed.data;
    const { vi, en } = body.translations;
    if (
      vi.hero.cover !== en.hero.cover ||
      vi.hero.ogImage !== en.hero.ogImage ||
      vi.hero.cta.url !== en.hero.cta.url
    )
      throw new BadRequestException(
        'Hero media and CTA destination must match in VI/EN',
      );
    const media = (doc: typeof vi.article.doc) => {
      const refs = new Map<string, string>();
      const visit = (node: (typeof doc.content)[number]) => {
        if (['articleImage', 'articleCta'].includes(node.type))
          refs.set(
            String(node.attrs?.id),
            JSON.stringify(
              node.type === 'articleImage'
                ? { src: node.attrs?.src, display: node.attrs?.display }
                : {
                    url: node.attrs?.url,
                    style: node.attrs?.style,
                    placement: node.attrs?.placement,
                  },
            ),
          );
        node.content?.forEach(visit);
      };
      doc.content.forEach(visit);
      return refs;
    };
    const viRefs = media(vi.article.doc),
      enRefs = media(en.article.doc);
    for (const [key, value] of viRefs)
      if (enRefs.has(key) && enRefs.get(key) !== value)
        throw new BadRequestException(
          'Shared article media/CTA reference differs across languages',
        );
    if (
      body.status === 'PUBLISHED' &&
      (!body.visible ||
        !vi.title.trim() ||
        !vi.hero.title.trim() ||
        !articleText(vi.article.doc))
    )
      throw new BadRequestException(
        'Vietnamese title, article and visibility are required for publishing',
      );
    let oldSlug = '';
    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.page.findUnique({
            where: { id },
            include: { sections: { include: { translations: true } } },
          });
          if (!existing || existing.kind !== PageKind.SOLUTION_DETAIL)
            throw new NotFoundException('Solution detail not found');
          oldSlug = existing.slug;
          const { section, byLocale } = await solutionModules(tx);
          const moduleKeys = new Set(
            (byLocale.vi || []).map((item) => item.key),
          );
          if (body.related.moduleKeys.some((key) => !moduleKeys.has(key)))
            throw new BadRequestException('Unknown related module');
          if (body.slug !== oldSlug) {
            // The listing slug is a reference, never a copy of the article.
            for (const translation of section.translations) {
              const content = translation.content as {
                items: Array<{ slug?: string }>;
              };
              const items = content.items.map((item) =>
                item.slug === oldSlug ? { ...item, slug: body.slug } : item,
              );
              await tx.pageSectionTranslation.update({
                where: { id: translation.id },
                data: { content: { ...content, items } },
              });
            }
          }
          const keys = ['hero', 'article', 'related'];
          if (
            keys.some(
              (key) =>
                !existing.sections.some((section) => section.key === key),
            )
          )
            throw new BadRequestException('Detail structure is incomplete');
          await tx.page.update({
            where: { id },
            data: {
              slug: body.slug,
              status: body.status,
              publishedAt:
                body.status === 'PUBLISHED'
                  ? body.publishedAt
                    ? new Date(body.publishedAt)
                    : existing.publishedAt || new Date()
                  : null,
            },
          });
          for (const locale of ['vi', 'en'] as const) {
            const value = body.translations[locale];
            await tx.pageTranslation.upsert({
              where: { pageId_locale: { pageId: id, locale } },
              create: {
                pageId: id,
                locale,
                title: value.title,
                seoTitle: value.seoTitle,
                seoDescription: value.seoDescription,
              },
              update: {
                title: value.title,
                seoTitle: value.seoTitle,
                seoDescription: value.seoDescription,
              },
            });
            for (const section of existing.sections.filter((section) =>
              keys.includes(section.key),
            )) {
              await tx.pageSection.update({
                where: { id: section.id },
                data: { enabled: body.visible },
              });
              const content =
                section.key === 'hero'
                  ? value.hero
                  : section.key === 'article'
                    ? value.article
                    : body.related;
              await tx.pageSectionTranslation.upsert({
                where: { sectionId_locale: { sectionId: section.id, locale } },
                create: {
                  sectionId: section.id,
                  locale,
                  content: content as Prisma.InputJsonValue,
                },
                update: { content: content as Prisma.InputJsonValue },
              });
            }
          }
          return tx.page.findUnique({
            where: { id },
            include: {
              translations: true,
              sections: {
                include: { translations: true },
                orderBy: { sortOrder: 'asc' },
              },
            },
          });
        },
        { isolationLevel: 'Serializable' },
      );
      await this.pageCache.invalidatePageLocales(oldSlug, ['vi', 'en']);
      if (body.slug !== oldSlug) {
        await this.pageCache.invalidatePageLocales(body.slug, ['vi', 'en']);
        await this.pageCache.invalidatePageLocales('solutions', ['vi', 'en']);
      }
      return result;
    } catch (error) {
      this.uniqueConflict(error, 'Detail slug already exists');
    }
  }

  async listPages() {
    return this.prisma.page.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        slug: true,
        kind: true,
        status: true,
        publishedAt: true,
        updatedAt: true,
        translations: {
          select: { locale: true, title: true },
          orderBy: { locale: 'asc' },
        },
      },
    });
  }

  async getPage(slug: string) {
    const page = await this.prisma.page.findUnique({
      where: { slug },
      include: {
        translations: true,
        sections: {
          orderBy: { sortOrder: 'asc' },
          include: { translations: true },
        },
      },
    });
    if (!page) throw new NotFoundException('Page not found');
    for (const section of page.sections) {
      const source = sharedSource(section.translations[0]?.content);
      if (source) {
        const consumers = await sharedConsumers(this.prisma, source);
        Object.assign(section, {
          source,
          sharedPages: [...new Set(consumers.map((item) => item.slug))],
        });
        section.translations = (await resolveSharedTranslations(
          this.prisma,
          section.translations,
        )) as typeof section.translations;
      }
    }
    return page;
  }

  async createPage(input: unknown) {
    const body = this.object(input);
    this.assertKeys(body, ['slug', 'translations']);
    const slug = this.slug(body.slug);
    const translations = this.translations(body.translations, true);
    try {
      return await this.prisma.$transaction((tx) =>
        tx.page.create({
          data: {
            slug,
            translations: { create: translations },
          },
          include: { translations: true },
        }),
      );
    } catch (error) {
      this.uniqueConflict(error, 'Page slug already exists');
    }
  }

  async updatePage(id: string, input: unknown, user: SafeUser) {
    const body = this.object(input);
    this.assertKeys(body, ['slug', 'status', 'publishedAt']);
    if (
      user.role !== UserRole.ADMIN &&
      (body.slug !== undefined ||
        body.status !== undefined ||
        body.publishedAt !== undefined)
    ) {
      throw new ForbiddenException('Editors cannot change page metadata');
    }
    const existingPage = await this.prisma.page.findUnique({
      where: { id },
      select: {
        slug: true,
        status: true,
        translations: { select: { locale: true } },
      },
    });
    if (!existingPage) throw new NotFoundException('Page not found');
    const data: Prisma.PageUpdateInput = {};
    if (body.slug !== undefined) data.slug = this.slug(body.slug);
    if (body.status !== undefined) {
      if (!this.isStatus(body.status))
        throw new BadRequestException('Invalid page status');
      data.status = body.status;
      if (body.status === PageStatus.PUBLISHED) {
        data.publishedAt = body.publishedAt
          ? this.date(body.publishedAt)
          : new Date();
      } else if (body.publishedAt !== undefined) {
        data.publishedAt =
          body.publishedAt === null ? null : this.date(body.publishedAt);
      }
    } else if (body.publishedAt !== undefined) {
      data.publishedAt =
        body.publishedAt === null ? null : this.date(body.publishedAt);
    }
    try {
      const updatedPage = await this.prisma.page.update({
        where: { id },
        data,
      });
      const slug =
        body.slug === undefined ? existingPage.slug : this.slug(body.slug);
      const locales = existingPage.translations.map(
        (translation) => translation.locale,
      );
      const statusChanged =
        body.status !== undefined && body.status !== existingPage.status;
      const slugChanged = slug !== existingPage.slug;
      if (statusChanged || slugChanged) {
        await this.pageCache.invalidatePageLocales(existingPage.slug, locales);
        if (slugChanged)
          await this.pageCache.invalidatePageLocales(slug, locales);
      }
      return updatedPage;
    } catch (error) {
      this.mapNotFoundOrConflict(
        error,
        'Page not found',
        'Page slug already exists',
      );
    }
  }

  async updateTranslation(pageId: string, locale: string, input: unknown) {
    const body = this.object(input);
    this.assertKeys(body, ['title', 'seoTitle', 'seoDescription']);
    const normalizedLocale = this.locale(locale);
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { id: true, slug: true },
    });
    if (!page) throw new NotFoundException('Page not found');
    const title = body.title;
    if (title !== undefined && typeof title !== 'string')
      throw new BadRequestException('Title must be a string');
    const existing = await this.prisma.pageTranslation.findUnique({
      where: { pageId_locale: { pageId, locale: normalizedLocale } },
    });
    if (!existing && (!title || !title.trim()))
      throw new BadRequestException('Title is required');
    try {
      const translation = await this.prisma.pageTranslation.upsert({
        where: { pageId_locale: { pageId, locale: normalizedLocale } },
        create: {
          pageId,
          locale: normalizedLocale,
          title: title.trim(),
          seoTitle: this.optionalText(body.seoTitle),
          seoDescription: this.optionalText(body.seoDescription),
        },
        update: {
          ...(title === undefined ? {} : { title: title.trim() }),
          ...(body.seoTitle === undefined
            ? {}
            : { seoTitle: this.optionalText(body.seoTitle) }),
          ...(body.seoDescription === undefined
            ? {}
            : { seoDescription: this.optionalText(body.seoDescription) }),
        },
      });
      await this.pageCache.invalidatePageLocale(page.slug, normalizedLocale);
      return translation;
    } catch (error) {
      this.mapNotFoundOrConflict(
        error,
        'Page not found',
        'Translation conflict',
      );
    }
  }

  async createSection(pageId: string, input: unknown, user: SafeUser) {
    if (user.role !== UserRole.ADMIN)
      throw new ForbiddenException('Admin role required');
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: {
        id: true,
        slug: true,
        translations: { select: { locale: true } },
      },
    });
    if (!page) throw new NotFoundException('Page not found');
    const body = this.object(input);
    this.assertKeys(body, ['key', 'type', 'sortOrder', 'enabled']);
    const key = this.text(body.key, 'Section key');
    const type = this.text(body.type, 'Section type');
    if (!isRegisteredSectionType(type))
      throw new BadRequestException(`Unknown section type: ${type}`);
    try {
      const section = await this.prisma.pageSection.create({
        data: {
          pageId,
          key,
          type,
          sortOrder: this.integer(body.sortOrder, 0),
          enabled:
            body.enabled === undefined ? true : this.boolean(body.enabled),
        },
        include: { translations: true },
      });
      await this.pageCache.invalidatePageLocales(
        page.slug,
        page.translations.map((translation) => translation.locale),
      );
      return section;
    } catch (error) {
      this.mapNotFoundOrConflict(
        error,
        'Page not found',
        'Section key already exists',
      );
    }
  }

  async updateSection(sectionId: string, input: unknown) {
    const body = this.object(input);
    this.assertKeys(body, ['sortOrder', 'enabled', 'key', 'type']);
    const section = await this.prisma.pageSection.findUnique({
      where: { id: sectionId },
      select: {
        page: {
          select: {
            slug: true,
            translations: { select: { locale: true } },
          },
        },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    const data: Prisma.PageSectionUpdateInput = {};
    if (body.sortOrder !== undefined)
      data.sortOrder = this.integer(body.sortOrder);
    if (body.enabled !== undefined) data.enabled = this.boolean(body.enabled);
    if (body.key !== undefined || body.type !== undefined) {
      throw new BadRequestException('Section key and type are immutable');
    }
    try {
      const updatedSection = await this.prisma.pageSection.update({
        where: { id: sectionId },
        data,
      });
      await this.pageCache.invalidatePageLocales(
        section.page.slug,
        section.page.translations.map((translation) => translation.locale),
      );
      return updatedSection;
    } catch (error) {
      this.mapNotFoundOrConflict(
        error,
        'Section not found',
        'Section conflict',
      );
    }
  }

  async updateSectionTranslation(
    sectionId: string,
    locale: string,
    input: unknown,
  ) {
    const body = this.object(input);
    this.assertKeys(body, ['content']);
    const normalizedLocale = this.locale(locale);
    const section = await this.prisma.pageSection.findUnique({
      where: { id: sectionId },
      select: {
        type: true,
        translations: {
          select: { id: true, locale: true, content: true },
        },
        page: {
          select: { slug: true },
        },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    const references = section.translations;
    section.translations = await resolveSharedTranslations(
      this.prisma,
      references,
    );
    try {
      const content = validateSectionContent(section.type, body.content);

      // Existing legacy Hero content may already be out of sync. Text edits are
      // still allowed, but structural slide changes must use the atomic
      // bilingual endpoint so a new/remove slide can never affect only VI or EN.
      if (this.isBilingualCollection(section.type)) {
        const existing = section.translations?.find(
          (translation) => translation.locale === normalizedLocale,
        );
        const beforeKeys = this.collectionKeys(section.type, existing?.content);
        const afterKeys = this.collectionKeys(section.type, content);
        if (!this.sameKeys(beforeKeys, afterKeys)) {
          throw new BadRequestException(
            'Hero slide structure must be updated for Vietnamese and English together',
          );
        }
      }

      const source = sharedSource(
        references.find((item) => item.locale === normalizedLocale)?.content,
      );
      if (source) {
        const setting = await this.prisma.siteSettingTranslation.update({
          where: {
            settingId_locale: {
              settingId: (
                await this.prisma.siteSetting.findUniqueOrThrow({
                  where: { key: source },
                })
              ).id,
              locale: normalizedLocale,
            },
          },
          data: { value: content as Prisma.InputJsonValue },
        });
        for (const consumer of await sharedConsumers(this.prisma, source))
          if (consumer.locale === normalizedLocale)
            await this.pageCache.invalidatePageLocale(
              consumer.slug,
              consumer.locale,
            );
        return {
          id: references.find((item) => item.locale === normalizedLocale)?.id,
          sectionId,
          locale: normalizedLocale,
          content,
          updatedAt: setting.updatedAt,
        };
      }
      const translation = await this.prisma.pageSectionTranslation.upsert({
        where: { sectionId_locale: { sectionId, locale: normalizedLocale } },
        create: {
          sectionId,
          locale: normalizedLocale,
          content: content as Prisma.InputJsonValue,
        },
        update: { content: content as Prisma.InputJsonValue },
      });
      await this.pageCache.invalidatePageLocale(
        section.page.slug,
        normalizedLocale,
      );
      return translation;
    } catch (error) {
      if (error instanceof SectionContentValidationError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }

  async updateSectionTranslations(sectionId: string, input: unknown) {
    const body = this.object(input);
    this.assertKeys(body, ['translations']);
    const translations = this.object(body.translations);
    this.assertKeys(translations, ['vi', 'en']);

    const viBody = this.object(translations.vi);
    const enBody = this.object(translations.en);
    this.assertKeys(viBody, ['content']);
    this.assertKeys(enBody, ['content']);

    const section = await this.prisma.pageSection.findUnique({
      where: { id: sectionId },
      select: {
        type: true,
        translations: { select: { id: true, locale: true, content: true } },
        page: { select: { slug: true } },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    const references = section.translations;
    section.translations = await resolveSharedTranslations(
      this.prisma,
      references,
    );

    try {
      const viContent = validateSectionContent(section.type, viBody.content);
      const enContent = validateSectionContent(section.type, enBody.content);

      if (this.isBilingualCollection(section.type)) {
        const viKeys = this.collectionKeys(section.type, viContent);
        const enKeys = this.collectionKeys(section.type, enContent);
        const previousVi = section.translations?.find(
          (item) => item.locale === 'vi',
        );
        const previousEn = section.translations?.find(
          (item) => item.locale === 'en',
        );
        const preservedLegacy =
          previousVi &&
          previousEn &&
          this.sameKeys(
            viKeys,
            this.collectionKeys(section.type, previousVi.content),
          ) &&
          this.sameKeys(
            enKeys,
            this.collectionKeys(section.type, previousEn.content),
          );
        if (
          !preservedLegacy &&
          (new Set(viKeys).size !== viKeys.length ||
            viKeys.some((key) => key.startsWith('#')))
        ) {
          throw new BadRequestException(
            'New bilingual items require unique structural keys',
          );
        }
        if (!this.sameKeys(viKeys, enKeys) && !preservedLegacy) {
          throw new BadRequestException(
            'Vietnamese and English Hero slides must have the same keys and order',
          );
        }
      }

      const sources = ['vi', 'en'].map((locale) =>
        sharedSource(
          references.find((item) => item.locale === locale)?.content,
        ),
      );
      if (sources.some(Boolean)) {
        if (!sources[0] || sources[0] !== sources[1])
          throw new BadRequestException(
            'Shared source must match both locales',
          );
        const source = sources[0];
        const result = await this.prisma.$transaction(async (tx) => {
          const setting = await tx.siteSetting.findUniqueOrThrow({
            where: { key: source },
          });
          const saved = {} as Record<string, unknown>;
          for (const [locale, content] of [
            ['vi', viContent],
            ['en', enContent],
          ] as const) {
            const translation = await tx.siteSettingTranslation.update({
              where: { settingId_locale: { settingId: setting.id, locale } },
              data: { value: content as Prisma.InputJsonValue },
            });
            saved[locale] = {
              id: references.find((item) => item.locale === locale)?.id,
              sectionId,
              locale,
              content,
              updatedAt: translation.updatedAt,
            };
          }
          return saved;
        });
        for (const consumer of await sharedConsumers(this.prisma, source))
          await this.pageCache.invalidatePageLocale(
            consumer.slug,
            consumer.locale,
          );
        return result;
      }
      const result = await this.prisma.$transaction(async (tx) => {
        const vi = await tx.pageSectionTranslation.upsert({
          where: { sectionId_locale: { sectionId, locale: 'vi' } },
          create: {
            sectionId,
            locale: 'vi',
            content: viContent as Prisma.InputJsonValue,
          },
          update: { content: viContent as Prisma.InputJsonValue },
        });

        const en = await tx.pageSectionTranslation.upsert({
          where: { sectionId_locale: { sectionId, locale: 'en' } },
          create: {
            sectionId,
            locale: 'en',
            content: enContent as Prisma.InputJsonValue,
          },
          update: { content: enContent as Prisma.InputJsonValue },
        });

        return { vi, en };
      });

      await this.pageCache.invalidatePageLocales(section.page.slug, [
        'vi',
        'en',
      ]);
      return result;
    } catch (error) {
      if (error instanceof SectionContentValidationError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }

  async reorderSections(pageId: string, input: unknown) {
    const body = this.object(input);
    this.assertKeys(body, ['sections']);
    if (!Array.isArray(body.sections) || body.sections.length === 0) {
      throw new BadRequestException('Sections must be a non-empty array');
    }
    const updates = body.sections.map((item: unknown) => {
      const value = this.object(item);
      return {
        id: this.text(value.id, 'Section id'),
        sortOrder: this.integer(value.sortOrder),
      };
    });
    const ids = updates.map((item) => item.id);
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { slug: true, translations: { select: { locale: true } } },
    });
    if (!page) throw new NotFoundException('Page not found');
    const owned = await this.prisma.pageSection.findMany({
      where: { pageId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length)
      throw new BadRequestException('All sections must belong to the page');
    await this.prisma.$transaction(async (tx) => {
      for (const item of updates) {
        await tx.pageSection.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        });
      }
    });
    await this.pageCache.invalidatePageLocales(
      page.slug,
      page.translations.map((translation) => translation.locale),
    );
    return this.getPageById(pageId);
  }

  private async getPageById(id: string) {
    const page = await this.prisma.page.findUnique({
      where: { id },
      include: {
        sections: {
          orderBy: { sortOrder: 'asc' },
          include: { translations: true },
        },
      },
    });
    if (!page) throw new NotFoundException('Page not found');
    return this.getPage(page.slug);
  }

  private object(value: unknown): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException('Request body must be an object');
    return value as Record<string, any>;
  }
  private assertKeys(value: Record<string, any>, allowed: string[]): void {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new BadRequestException(`Unknown field: ${unknown}`);
  }
  private text(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim())
      throw new BadRequestException(`${field} is required`);
    return value.trim();
  }
  private slug(value: unknown): string {
    const slug = this.text(value, 'Slug').toLowerCase();
    if (!SLUG_PATTERN.test(slug)) throw new BadRequestException('Invalid slug');
    return slug;
  }
  private locale(value: string): string {
    const locale = value.trim().toLowerCase();
    if (!LOCALE_PATTERN.test(locale))
      throw new BadRequestException('Invalid locale');
    return locale;
  }
  private translations(value: unknown, required: boolean) {
    if (!Array.isArray(value) || (required && value.length === 0))
      throw new BadRequestException('Translations are required');
    return value.map((item) => {
      const body = this.object(item);
      return {
        locale: this.locale(this.text(body.locale, 'Locale')),
        title: this.text(body.title, 'Title'),
      };
    });
  }
  private integer(value: unknown, fallback?: number): number {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value))
      throw new BadRequestException('Sort order must be an integer');
    return value;
  }
  private boolean(value: unknown): boolean {
    if (typeof value !== 'boolean')
      throw new BadRequestException('Enabled must be a boolean');
    return value;
  }
  private optionalText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string')
      throw new BadRequestException('SEO fields must be strings');
    return value.trim() || null;
  }

  private isBilingualCollection(type: string): boolean {
    return [
      'hero',
      'why',
      'proofMetrics',
      'trustedLogos',
      'solutionClusters',
      'testimonials',
      'faq',
      'solutionGroups',
      'solutionModules',
      'solutionOverview',
    ].includes(type);
  }

  private collectionKeys(type: string, content: unknown): string[] {
    if (!content || typeof content !== 'object' || Array.isArray(content))
      return [];
    const slides =
      type === 'hero'
        ? (content as { slides?: unknown }).slides
        : (content as { items?: unknown }).items;
    if (!Array.isArray(slides)) return [];

    const keys = slides.map((slide, index) => {
      if (
        slide &&
        typeof slide === 'object' &&
        !Array.isArray(slide) &&
        typeof (slide as { key?: unknown }).key === 'string' &&
        (slide as { key: string }).key.trim()
      ) {
        const key = (slide as { key: string }).key.trim();
        if (type === 'solutionOverview') {
          const modules =
            (slide as { modules?: Array<{ key: string }> }).modules || [];
          return JSON.stringify([key, modules.map((item) => item.key)]);
        }
        return key;
      }
      return `#${index}`;
    });
    const actions =
      (content as { actions?: Array<{ key: string }> }).actions || [];
    return [...keys, ...actions.map((item) => 'action:' + item.key)];
  }

  private sameKeys(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((key, index) => key === right[index])
    );
  }

  private date(value: unknown): Date {
    if (typeof value !== 'string' && !(value instanceof Date))
      throw new BadRequestException('publishedAt must be a valid date');
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new BadRequestException('publishedAt must be a valid date');
    return date;
  }
  private isStatus(value: unknown): value is PageStatus {
    return Object.values(PageStatus).includes(value as PageStatus);
  }
  private uniqueConflict(error: unknown, message: string): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    )
      throw new ConflictException(message);
    throw error;
  }
  private mapNotFoundOrConflict(
    error: unknown,
    notFound: string,
    conflict: string,
  ): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025') throw new NotFoundException(notFound);
      if (error.code === 'P2002') throw new ConflictException(conflict);
    }
    throw error;
  }
}
