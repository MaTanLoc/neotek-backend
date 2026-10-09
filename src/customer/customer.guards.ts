import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { CustomerPrincipal } from '../booking/booking-domain';
import {
  CUSTOMER_COOKIE,
  CustomerSessionService,
} from './customer-session.service';

export type CustomerRequest = Request & {
  customer: CustomerPrincipal & {
    email: string;
    name: string;
    emailVerifiedAt: Date | null;
  };
};
@Injectable()
export class CustomerGuard implements CanActivate {
  private readonly sessions: CustomerSessionService;
  constructor(sessions: CustomerSessionService) {
    this.sessions = sessions;
  }
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<CustomerRequest>();
    req.customer = await this.sessions.resolve(req.cookies?.[CUSTOMER_COOKIE]);
    return true;
  }
}
@Injectable()
export class CustomerMutationGuard implements CanActivate {
  private readonly sessions: CustomerSessionService;
  constructor(sessions: CustomerSessionService) {
    this.sessions = sessions;
  }
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<CustomerRequest>();
    await this.sessions.validateCsrf(
      req.cookies?.[CUSTOMER_COOKIE],
      req.headers['x-csrf-token'],
    );
    await this.sessions.rate(req.customer.customerId, 'mutation');
    return true;
  }
}
