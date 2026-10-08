import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  INestApplication,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response, Express, json, urlencoded } from 'express';
import helmet from 'helmet';
import * as cookieParser from 'cookie-parser';

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const parserError = error as { type?: string; status?: number };
    const status =
      error instanceof HttpException
        ? error.getStatus()
        : parserError?.type === 'entity.too.large'
          ? 413
          : parserError?.type === 'entity.parse.failed'
            ? 400
            : 500;
    if (status >= 500)
      this.logger.error(
        `Request failed status=${status} requestId=${String(response.getHeader('x-request-id'))}`,
      );
    const payload = error instanceof HttpException ? error.getResponse() : null;
    const validationMessages =
      payload && typeof payload === 'object' && 'message' in payload
        ? payload.message
        : null;
    const message =
      status >= 500
        ? 'Service unavailable'
        : Array.isArray(validationMessages) &&
            validationMessages.every((value) => typeof value === 'string')
          ? validationMessages.slice(0, 20).map((value) => value.slice(0, 1000))
          : error instanceof HttpException
            ? error.message
            : status === 413
              ? 'Request body too large'
              : 'Invalid request body';
    if (status === 503 && error instanceof HttpException) {
      const body = error.getResponse() as {
        status?: unknown;
        database?: unknown;
        cache?: unknown;
      };
      if (
        body?.status === 'error' &&
        ['up', 'down'].includes(String(body.database)) &&
        ['up', 'down'].includes(String(body.cache))
      ) {
        response.status(status).json({
          statusCode: status,
          status: 'error',
          database: body.database,
          cache: body.cache,
        });
        return;
      }
    }
    response.status(status).json({ statusCode: status, message });
  }
}

export function configureHttpSecurity(app: INestApplication): () => void {
  let draining = false;
  const server = app.getHttpAdapter().getInstance() as Express;
  server.set(
    'trust proxy',
    process.env.TRUST_PROXY?.split(',').map((value) => value.trim()) || false,
  );
  app.setGlobalPrefix('api');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use((request: Request, response: Response, next: () => void) => {
    const requestId = randomUUID();
    const started = Date.now();
    response.setHeader('x-request-id', requestId);
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    if (/^\/api\/(auth|admin|users)(\/|$)/i.test(request.path))
      response.setHeader('Cache-Control', 'no-store');
    if (draining && request.path !== '/api/health/live') {
      response
        .status(503)
        .json({ statusCode: 503, message: 'Service shutting down' });
      return;
    }
    response.on('finish', () =>
      new Logger('HTTP').log(
        `${request.method} ${request.route?.path || '[unmatched]'} status=${response.statusCode} durationMs=${Date.now() - started} requestId=${requestId}`,
      ),
    );
    next();
  });
  app.use(cookieParser());
  app.use(json({ limit: '2mb' }));
  app.use(urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }));
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-csrf-token'],
  });
  app.useGlobalFilters(new SafeExceptionFilter());
  return () => {
    draining = true;
  };
}
