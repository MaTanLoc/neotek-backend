import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from './auth.types';
import {
  ADMIN_SESSION_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
} from './auth.constants';
import { AuthService } from './auth.service';

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const sessionToken = request.cookies?.[ADMIN_SESSION_COOKIE];
    const header = request.headers?.[CSRF_HEADER];
    const headerToken = Array.isArray(header) ? header[0] : header;
    const cookieToken = request.cookies?.[CSRF_COOKIE];
    if (
      !sessionToken ||
      !headerToken ||
      !cookieToken ||
      headerToken !== cookieToken
    ) {
      throw new UnauthorizedException('Invalid CSRF token');
    }
    await this.authService.validateCsrfToken(sessionToken, headerToken);
    return true;
  }
}
