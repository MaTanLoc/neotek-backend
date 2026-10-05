import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { CacheModule } from './cache/cache.module';
import { HealthModule } from './health/health.module';
import { MediaModule } from './media/media.module';
import { PagesModule } from './pages/pages.module';
import { PrismaModule } from './prisma/prisma.module';
import { SectionsModule } from './sections/sections.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AdminModule,
    AuthModule,
    UsersModule,
    PagesModule,
    SectionsModule,
    MediaModule,
    CacheModule,
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
