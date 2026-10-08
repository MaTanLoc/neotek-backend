import { AdminRateLimitGuard } from '../auth/admin-rate-limit.guard';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest } from '../auth/auth.types';
import { CsrfGuard } from '../auth/csrf.guard';
import { OriginGuard } from '../auth/origin.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { AdminService } from './admin.service';

@Controller('admin')
@UseGuards(SessionAuthGuard, RolesGuard, AdminRateLimitGuard)
export class AdminController {
  private readonly service: AdminService;

  constructor(service: AdminService) {
    this.service = service;
  }

  @Get('solutions')
  listSolutionDetails() {
    return this.service.listSolutionDetails();
  }

  @Get('solutions/:slug')
  getSolutionDetail(@Param('slug') slug: string) {
    return this.service.getSolutionDetail(slug);
  }

  @Post('solutions')
  @UseGuards(CsrfGuard, OriginGuard)
  createSolutionDetail(@Body() body: unknown) {
    return this.service.createSolutionDetail(body);
  }

  @Put('solutions/:id')
  @UseGuards(CsrfGuard, OriginGuard)
  saveSolutionDetail(@Param('id') id: string, @Body() body: unknown) {
    return this.service.saveSolutionDetail(id, body);
  }

  @Get('pages')
  listPages() {
    return this.service.listPages();
  }

  @Get('pages/:slug')
  getPage(@Param('slug') slug: string) {
    return this.service.getPage(slug.trim().toLowerCase());
  }

  @Post('pages')
  @Roles(UserRole.ADMIN)
  @UseGuards(CsrfGuard, OriginGuard)
  createPage(@Body() body: unknown) {
    return this.service.createPage(body);
  }

  @Patch('pages/:id')
  @UseGuards(CsrfGuard, OriginGuard)
  updatePage(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updatePage(id, body, request.user!);
  }

  @Patch('pages/:pageId/translations/:locale')
  @UseGuards(CsrfGuard, OriginGuard)
  updateTranslation(
    @Param('pageId') pageId: string,
    @Param('locale') locale: string,
    @Body() body: unknown,
  ) {
    return this.service.updateTranslation(pageId, locale, body);
  }

  @Post('pages/:pageId/sections')
  @Roles(UserRole.ADMIN)
  @UseGuards(CsrfGuard, OriginGuard)
  createSection(
    @Param('pageId') pageId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.createSection(pageId, body, request.user!);
  }

  @Patch('sections/:sectionId')
  @UseGuards(CsrfGuard, OriginGuard)
  updateSection(@Param('sectionId') sectionId: string, @Body() body: unknown) {
    return this.service.updateSection(sectionId, body);
  }

  @Put('sections/:sectionId/translations/:locale')
  @UseGuards(CsrfGuard, OriginGuard)
  updateSectionTranslation(
    @Param('sectionId') sectionId: string,
    @Param('locale') locale: string,
    @Body() body: unknown,
  ) {
    return this.service.updateSectionTranslation(sectionId, locale, body);
  }

  @Put('sections/:sectionId/translations')
  @UseGuards(CsrfGuard, OriginGuard)
  updateSectionTranslations(
    @Param('sectionId') sectionId: string,
    @Body() body: unknown,
  ) {
    return this.service.updateSectionTranslations(sectionId, body);
  }

  @Put('pages/:pageId/sections/order')
  @UseGuards(CsrfGuard, OriginGuard)
  reorderSections(@Param('pageId') pageId: string, @Body() body: unknown) {
    return this.service.reorderSections(pageId, body);
  }
}
