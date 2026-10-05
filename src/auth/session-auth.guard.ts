import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from './auth.types';
import { ADMIN_SESSION_COOKIE } from './auth.constants';
import { AuthService } from './auth.service';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  private readonly authService: AuthService;

  constructor(authService: AuthService) {
    this.authService = authService;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (!token) {
      throw new UnauthorizedException('Authentication required');
    }
    request.user = await this.authService.getAuthenticatedUser(token);
    return true;
  }
}
