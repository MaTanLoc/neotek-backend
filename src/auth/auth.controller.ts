import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth.service';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
} from './auth.constants';
import { AuthenticatedRequest } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { SessionAuthGuard } from './session-auth.guard';
import { CsrfGuard } from './csrf.guard';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { OriginGuard } from './origin.guard';
import { CSRF_COOKIE } from './auth.constants';

@Controller('auth')
export class AuthController {
  private readonly authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(LoginRateLimitGuard)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: unknown }> {
    if (
      !body ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string' ||
      !body.email.trim()
    ) {
      throw new BadRequestException('Email and password are required');
    }
    if (body.password.length < 12 || body.password.length > 256) {
      throw new BadRequestException('Password length is invalid');
    }
    const result = await this.authService.login(body.email, body.password);
    response.cookie(ADMIN_SESSION_COOKIE, result.token, this.cookieOptions());
    return { user: result.user };
  }

  @UseGuards(SessionAuthGuard)
  @Get('me')
  me(@Req() request: AuthenticatedRequest): { user: unknown } {
    return { user: request.user };
  }

  @UseGuards(SessionAuthGuard)
  @Get('csrf')
  async csrf(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ csrfToken: string }> {
    const sessionToken = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (!sessionToken) {
      throw new BadRequestException('Authentication required');
    }
    const csrfToken = await this.authService.createCsrfToken(sessionToken);
    response.cookie(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 28_800_000,
    });
    return { csrfToken };
  }

  @UseGuards(SessionAuthGuard, CsrfGuard, OriginGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ success: true }> {
    const token = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (token) {
      await this.authService.revoke(token);
    }
    response.clearCookie(ADMIN_SESSION_COOKIE, { path: '/' });
    response.clearCookie(CSRF_COOKIE, { path: '/' });
    return { success: true };
  }

  private cookieOptions(): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'lax';
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: ADMIN_SESSION_TTL_SECONDS * 1000,
    };
  }
}
