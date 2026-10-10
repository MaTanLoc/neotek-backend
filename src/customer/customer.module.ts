import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { CacheService } from '../cache/cache.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationModule } from '../notification/notification.module';
import { VerificationSecret } from '../notification/verification-secret';
import { CustomerService } from './customer.service';
import { CustomerPasswordRecoveryService } from './customer-password-recovery.service';
import { AuthModule } from '../auth/auth.module';
import { CustomerController } from './customer.controller';
import { CustomerSessionService } from './customer-session.service';
import { CustomerGuard, CustomerMutationGuard } from './customer.guards';
import { CustomerGoogleService } from './customer-google.service';
import { GoogleTokenVerifier } from './google-token-verifier';

@Module({
  imports: [PrismaModule, CacheModule, NotificationModule, AuthModule],
  controllers: [CustomerController],
  providers: [
    GoogleTokenVerifier,
    CustomerGoogleService,
    {
      provide: CustomerPasswordRecoveryService,
      inject: [PrismaService, CacheService, NotificationService],
      useFactory: (
        db: PrismaService,
        cache: CacheService,
        notifications: NotificationService,
      ) =>
        new CustomerPasswordRecoveryService(
          db,
          cache,
          notifications,
          new VerificationSecret(
            process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY ?? '',
          ),
        ),
    },
    CustomerSessionService,
    CustomerGuard,
    CustomerMutationGuard,
    {
      provide: CustomerService,
      inject: [PrismaService, NotificationService, CacheService],
      useFactory: (
        db: PrismaService,
        notifications: NotificationService,
        cache: CacheService,
      ) =>
        new CustomerService(
          db,
          notifications,
          cache,
          new VerificationSecret(
            process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY ?? '',
          ),
        ),
    },
  ],
  exports: [
    CustomerService,
    CustomerSessionService,
    CustomerGuard,
    CustomerMutationGuard,
  ],
})
export class CustomerModule {}
