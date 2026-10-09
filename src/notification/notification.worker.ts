import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from './notification.service';
import { ConfiguredEmailProvider } from './email-provider';
import { VerificationSecret } from './verification-secret';
import { setTimeout, clearTimeout } from 'node:timers';

@Injectable()
export class NotificationWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending?: Promise<void>;
  private readonly logger = new Logger(NotificationWorker.name);
  private readonly db: PrismaService;
  private readonly notifications: NotificationService;
  constructor(db: PrismaService, notifications: NotificationService) {
    this.db = db;
    this.notifications = notifications;
  }
  onModuleInit() {
    // Missing dev credentials leave durable intents pending, never marked SENT.
    if (
      !process.env.EMAIL_PROVIDER ||
      process.env.EMAIL_PROVIDER === 'disabled'
    ) {
      this.logger.warn('Email transport disabled; outbox remains pending');
      return;
    }
    const provider = new ConfiguredEmailProvider(this.db);
    const secrets = new VerificationSecret(
      process.env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY ?? '',
    );
    const tick = async () => {
      try {
        for (let i = 0; i < 10 && !this.stopped; i++) {
          if (
            !(await this.notifications.dispatchOne(this.db, provider, secrets))
          )
            break;
        }
      } catch {
        this.logger.error('Notification dispatcher dependency unavailable');
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.pending = tick();
        }, 2000);
        this.timer.unref();
      }
    };
    this.pending = tick();
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
