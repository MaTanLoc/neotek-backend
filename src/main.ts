import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.FRONTEND_URL || !process.env.REDIS_URL)
  ) {
    throw new Error('FRONTEND_URL and REDIS_URL are required in production');
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: '1mb' }));
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
