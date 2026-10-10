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
import { GoogleCalendarService } from './google-calendar.service';
import { GoogleCalendarClient } from './google-calendar.client';
import {
  AdminGoogleCalendarController,
  GoogleCalendarCallbackController,
} from './google-calendar.controller';

@Module({
  imports: [
    PrismaModule,
    NotificationModule,
    CustomerModule,
    AuthModule,
    CacheModule,
  ],
  controllers: [
    BookingController,
    AdminBookingController,
    AdminGoogleCalendarController,
    GoogleCalendarCallbackController,
  ],
  providers: [
    GoogleCalendarService,
    GoogleCalendarClient,
    {
      provide: BookingService,
      inject: [PrismaService, NotificationService, GoogleCalendarService],
      useFactory: (
        db: PrismaService,
        notifications: NotificationService,
        calendar: GoogleCalendarService,
      ) =>
        new BookingService(db, notifications, undefined, undefined, calendar),
    },
  ],
  exports: [BookingService],
})
export class BookingModule {}
