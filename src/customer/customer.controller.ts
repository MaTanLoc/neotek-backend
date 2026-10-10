import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';
import { URL } from 'node:url';
import { OriginGuard } from '../auth/origin.guard';
import { parseInput } from '../booking/booking-domain';
import { CustomerService } from './customer.service';
import { CustomerPasswordRecoveryService } from './customer-password-recovery.service';
import { CustomerGoogleService } from './customer-google.service';
import {
  CUSTOMER_COOKIE,
  CUSTOMER_TTL,
  CustomerSessionService,
} from './customer-session.service';
import {
  CustomerGuard,
  CustomerMutationGuard,
  CustomerRequest,
} from './customer.guards';

export function customerCookieOptions() {
  let local = false;
  try {
    const url = new URL(process.env.FRONTEND_URL ?? '');
    local =
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    /* Fail secure. */
  }
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || !local,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: CUSTOMER_TTL * 1000,
  };
}
@Controller('customer-auth')
export class CustomerController {
  private readonly customers: CustomerService;
  private readonly sessions: CustomerSessionService;
  private readonly recovery: CustomerPasswordRecoveryService;
  private readonly google: CustomerGoogleService;
  constructor(
    customers: CustomerService,
    sessions: CustomerSessionService,
    recovery: CustomerPasswordRecoveryService,
    google: CustomerGoogleService,
  ) {
    this.customers = customers;
    this.sessions = sessions;
    this.recovery = recovery;
    this.google = google;
  }
  @Post('register')
  @HttpCode(202)
  @UseGuards(OriginGuard)
  register(@Body() input: unknown, @Req() req: Request) {
    return this.customers.register(input, req.ip ?? 'unknown');
  }
  @Post('login')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  async login(
    @Body() input: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const principal = await this.customers.authenticate(
      input,
      req.ip ?? 'unknown',
    );
    return this.finishLogin(principal, req, res);
  }
  @Post('google')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  async googleLogin(
    @Body() input: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.finishLogin(
      await this.google.authenticate(input, req.ip ?? 'unknown'),
      req,
      res,
    );
  }
  private async finishLogin(
    principal:
      | Awaited<ReturnType<CustomerService['authenticate']>>
      | Awaited<ReturnType<CustomerGoogleService['authenticate']>>,
    req: Request,
    res: Response,
  ) {
    const { authVersion, ...customer } = principal;
    const token = await this.sessions.issue(customer.customerId, authVersion);
    const old = req.cookies?.[CUSTOMER_COOKIE];
    if (typeof old === 'string') await this.sessions.revoke(old);
    res.cookie(CUSTOMER_COOKIE, token, customerCookieOptions());
    return { customer };
  }
  @Get('me')
  @UseGuards(CustomerGuard)
  me(@Req() req: CustomerRequest) {
    return { customer: req.customer };
  }
  @Get('csrf')
  @UseGuards(CustomerGuard)
  async csrf(@Req() req: CustomerRequest) {
    await this.sessions.rate(req.customer.customerId, 'csrf', 120);
    return {
      csrfToken: await this.sessions.csrf(req.cookies[CUSTOMER_COOKIE]),
    };
  }
  @Post('logout')
  @HttpCode(200)
  @UseGuards(CustomerGuard, OriginGuard, CustomerMutationGuard)
  async logout(
    @Req() req: CustomerRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.sessions.revoke(req.cookies[CUSTOMER_COOKIE]);
    res.clearCookie(CUSTOMER_COOKIE, {
      ...customerCookieOptions(),
      maxAge: undefined,
    });
    return { success: true };
  }
  @Post('verify-email')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  verify(@Body() input: unknown, @Req() req: Request) {
    const { token } = parseInput(
      z.object({ token: z.string().max(100) }).strict(),
      input,
    );
    return this.customers.verify(token, req.ip ?? 'unknown');
  }
  @Post('forgot-password')
  @HttpCode(202)
  @UseGuards(OriginGuard)
  forgot(@Body() input: unknown, @Req() req: Request) {
    return this.recovery.forgot(input, req.ip ?? 'unknown');
  }
  @Post('reset-password')
  @HttpCode(200)
  @UseGuards(OriginGuard)
  reset(@Body() input: unknown, @Req() req: Request) {
    return this.recovery.reset(input, req.ip ?? 'unknown');
  }
  @Post('resend-verification')
  @HttpCode(202)
  @UseGuards(OriginGuard)
  resend(@Body() input: unknown, @Req() req: Request) {
    return this.customers.resendByEmail(input, req.ip ?? 'unknown');
  }
}
