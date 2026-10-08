import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { configureHttpSecurity } from './config/http-security';
import { AppModule } from './app.module';
import {
  validateEnvironment,
  EnvironmentValidationError,
} from './config/validate-environment';
import { RuntimeLogger } from './config/runtime-logger';
import { error as logFatal } from 'node:console';

// Fatal failures terminate; a supervisor must restart, never continue corruption.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, () => {
    logFatal(`Fatal runtime failure (${event}); supervisor restart required`);
    process.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  validateEnvironment(process.env);
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    abortOnError: false,
    logger: new RuntimeLogger(),
  });
  const drain = configureHttpSecurity(app);
  process.prependOnceListener('SIGTERM', drain);
  process.prependOnceListener('SIGINT', drain);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap().catch((error: unknown) => {
  logFatal(
    error instanceof EnvironmentValidationError
      ? error.message
      : 'Backend startup failed; check configuration and dependency availability',
  );
  process.exit(1);
});
