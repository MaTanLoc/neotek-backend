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
import { URL } from 'node:url';
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
import { AdminRateLimitGuard } from './admin-rate-limit.guard';

@Controller('auth')
export class AuthController {
  private readonly authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OriginGuard, LoginRateLimitGuard)
  async login(
    @Body() body: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: unknown }> {
    if (
      !body ||
      typeof body.email !== 'string' ||
      typeof body.password !== 'string' ||
      !body.email.trim() ||
      body.email.length > 254 ||
      Object.keys(body).some((key) => !['email', 'password'].includes(key))
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

  @UseGuards(SessionAuthGuard, AdminRateLimitGuard)
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
      secure: this.secureCookie(),
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
    const options = { ...this.cookieOptions(), maxAge: undefined };
    response.clearCookie(ADMIN_SESSION_COOKIE, options);
    response.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
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
      secure: this.secureCookie(),
      sameSite: 'lax',
      path: '/',
      maxAge: ADMIN_SESSION_TTL_SECONDS * 1000,
    };
  }

  private secureCookie(): boolean {
    if (process.env.NODE_ENV === 'production') return true;
    try {
      const origin = new URL(
        process.env.FRONTEND_URL || 'http://localhost:5173',
      );
      return !(
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      );
    } catch {
      return true;
    }
  }
}
