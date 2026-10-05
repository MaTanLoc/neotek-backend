import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CsrfGuard } from './csrf.guard';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { OriginGuard } from './origin.guard';
import { RolesGuard } from './roles.guard';
import { SessionAuthGuard } from './session-auth.guard';

@Module({
  imports: [CacheModule, PrismaModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionAuthGuard,
    RolesGuard,
    CsrfGuard,
    LoginRateLimitGuard,
    OriginGuard,
  ],
  exports: [AuthService, SessionAuthGuard, RolesGuard, CsrfGuard, OriginGuard],
})
export class AuthModule {}
