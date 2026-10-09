import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationWorker } from './notification.worker';

@Module({
  imports: [PrismaModule],
  providers: [NotificationService, NotificationWorker],
  exports: [NotificationService],
})
export class NotificationModule {}
