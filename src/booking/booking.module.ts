import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationModule } from '../notification/notification.module';
import { BookingService } from './booking.service';
import { CustomerModule } from '../customer/customer.module';
import { AuthModule } from '../auth/auth.module';
import { CacheModule } from '../cache/cache.module';
import { BookingController } from './booking.controller';
import { AdminBookingController } from './admin-booking.controller';

@Module({
  imports: [
    PrismaModule,
    NotificationModule,
    CustomerModule,
    AuthModule,
    CacheModule,
  ],
  controllers: [BookingController, AdminBookingController],
  providers: [
    {
      provide: BookingService,
      inject: [PrismaService, NotificationService],
      useFactory: (db: PrismaService, notifications: NotificationService) =>
        new BookingService(db, notifications),
    },
  ],
  exports: [BookingService],
})
export class BookingModule {}
