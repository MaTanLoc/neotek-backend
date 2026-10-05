import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PageStatus, Prisma, UserRole } from '@prisma/client';
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

  async listPages() {
    return this.prisma.page.findMany({
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        slug: true,
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
        page: {
          select: { slug: true },
        },
      },
    });
    if (!section) throw new NotFoundException('Section not found');
    try {
      const content = validateSectionContent(section.type, body.content);
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
    return page;
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
