import {
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest } from '../auth/auth.types';
import { ADMIN_SESSION_COOKIE } from '../auth/auth.constants';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CsrfGuard } from '../auth/csrf.guard';
import { OriginGuard } from '../auth/origin.guard';
import { AdminRateLimitGuard } from '../auth/admin-rate-limit.guard';
import { GoogleCalendarService } from './google-calendar.service';

@Controller('admin/integrations/google/calendar')
@Roles(UserRole.ADMIN)
@UseGuards(SessionAuthGuard, RolesGuard, AdminRateLimitGuard)
export class AdminGoogleCalendarController {
  private readonly calendar: GoogleCalendarService;
  constructor(calendar: GoogleCalendarService) {
    this.calendar = calendar;
  }
  @Get()
  status() {
    return this.calendar.status();
  }
  @Get('connect')
  @UseGuards(CsrfGuard, OriginGuard)
  connect(@Req() req: AuthenticatedRequest) {
    return this.calendar.connect(req.cookies![ADMIN_SESSION_COOKIE]);
  }
  // Browsers supply Origin reliably on POST. Retain the requested guarded GET
  // route for clients that can supply the exact Origin and CSRF headers.
  @Post('connect')
  @UseGuards(CsrfGuard, OriginGuard)
  connectPost(@Req() req: AuthenticatedRequest) {
    return this.connect(req);
  }
}

@Controller('integrations/google/calendar')
@Roles(UserRole.ADMIN)
@UseGuards(SessionAuthGuard, RolesGuard, AdminRateLimitGuard)
export class GoogleCalendarCallbackController {
  private readonly calendar: GoogleCalendarService;
  constructor(calendar: GoogleCalendarService) {
    this.calendar = calendar;
  }
  @Get('callback')
  async callback(
    @Req() req: AuthenticatedRequest,
    @Query('state') state: unknown,
    @Query('code') code: unknown,
    @Query('error') error: unknown,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // OAuth returns cross-site: session + one-use state replace Origin/CSRF here.
    const redirect = await this.calendar.callback(
      req.cookies![ADMIN_SESSION_COOKIE],
      state,
      code,
      error,
    );
    res.redirect(303, redirect);
  }
}
