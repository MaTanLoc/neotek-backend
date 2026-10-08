import {
  Injectable,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CacheService } from '../cache/cache.service';
import { PrismaService } from '../prisma/prisma.service';
import { ADMIN_SESSION_TTL_SECONDS } from './auth.constants';
import { SafeUser, SessionData } from './auth.types';
import { hashPassword, verifyPassword } from './password.util';

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$wb24d1PJKvzZBGU3IFpR/A$8yee02HkWPo4d12Ayme7MsDuYEMKJBEBbLycxxL+Ues';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly prisma: PrismaService;
  private readonly cache: CacheService;

  constructor(prisma: PrismaService, cache: CacheService) {
    this.prisma = prisma;
    this.cache = cache;
  }

  async hashPassword(password: string): Promise<string> {
    return hashPassword(password);
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    return verifyPassword(hash, password);
  }

  async login(
    email: string,
    password: string,
  ): Promise<{
    user: SafeUser;
    token: string;
  }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        passwordHash: true,
      },
    });
    const passwordValid = user
      ? await this.verifyPassword(user.passwordHash, password)
      : await this.verifyPassword(DUMMY_PASSWORD_HASH, password);

    if (!user || !user.active || !passwordValid) {
      this.logger.warn('Admin login failed');
      throw new UnauthorizedException('Invalid email or password');
    }

    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const session: SessionData = {
      userId: user.id,
      role: user.role,
      createdAt: now,
      lastSeenAt: now,
    };

    try {
      await this.cache.set(
        this.sessionKey(token),
        JSON.stringify(session),
        ADMIN_SESSION_TTL_SECONDS,
      );
    } catch {
      this.logger.error(`Admin session store unavailable: dependency failure`);
      throw new InternalServerErrorException(
        'Authentication service unavailable',
      );
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    this.logger.log(`Admin login succeeded for user ${user.id}`);
    return { user: this.safeUser(user), token };
  }

  async getAuthenticatedUser(token: string): Promise<SafeUser> {
    let serialized: string | null;
    try {
      serialized = await this.cache.get(this.sessionKey(token));
    } catch {
      this.logger.error(`Admin session lookup unavailable: dependency failure`);
      throw new InternalServerErrorException(
        'Authentication service unavailable',
      );
    }

    if (!serialized) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    let session: SessionData;
    try {
      session = JSON.parse(serialized) as SessionData;
    } catch {
      await this.revoke(token);
      throw new UnauthorizedException('Invalid or expired session');
    }
    if (
      !session ||
      typeof session.userId !== 'string' ||
      typeof session.createdAt !== 'string' ||
      typeof session.lastSeenAt !== 'string'
    ) {
      await this.revoke(token);
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, role: true, active: true },
    });
    if (!user || !user.active) {
      await this.revoke(token);
      throw new UnauthorizedException('Invalid or expired session');
    }
    return this.safeUser(user);
  }

  async createCsrfToken(sessionToken: string): Promise<string> {
    let token: string | null;
    try {
      token = await this.cache.getOrCreateSessionToken(
        this.sessionKey(sessionToken),
        this.csrfKey(sessionToken),
        randomBytes(32).toString('base64url'),
      );
    } catch {
      this.logger.error(`CSRF token store unavailable: dependency failure`);
      throw new InternalServerErrorException(
        'Authentication service unavailable',
      );
    }
    if (!token) throw new UnauthorizedException('Invalid or expired session');
    return token;
  }

  async validateCsrfToken(sessionToken: string, token: string): Promise<void> {
    let expected: string | null;
    try {
      expected = await this.cache.get(this.csrfKey(sessionToken));
    } catch {
      this.logger.error(`CSRF token lookup unavailable: dependency failure`);
      throw new InternalServerErrorException(
        'Authentication service unavailable',
      );
    }
    if (
      !expected ||
      Buffer.byteLength(expected) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(token))
    ) {
      throw new ForbiddenException('Invalid CSRF token');
    }
  }

  async revoke(token: string): Promise<void> {
    try {
      await this.cache.del(this.sessionKey(token));
      await this.cache.del(this.csrfKey(token));
    } catch {
      this.logger.error(`Admin session revoke failed: dependency failure`);
      throw new InternalServerErrorException(
        'Authentication service unavailable',
      );
    }
  }

  private sessionKey(token: string): string {
    return `auth:session:${createHash('sha256').update(token).digest('hex')}`;
  }

  private csrfKey(token: string): string {
    return `auth:csrf:${createHash('sha256').update(token).digest('hex')}`;
  }

  private safeUser(user: {
    id: string;
    email: string;
    name: string | null;
    role: UserRole;
  }): SafeUser {
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }
}
