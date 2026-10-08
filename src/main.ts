import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/validate-environment';

async function bootstrap(): Promise<void> {
  validateEnvironment(process.env);
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.use(json({ limit: '1mb' }));
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-csrf-token'],
  });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
