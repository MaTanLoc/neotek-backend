import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { VerificationSecret } from '../notification/verification-secret';
import { CALENDAR_SCOPE, calendarConfig } from './google-calendar.config';
import { GoogleCalendarClient } from './google-calendar.client';

const credentialId = 'google-calendar-organizer';
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private readonly db: PrismaService;
  private readonly cache: CacheService;
  private readonly client: GoogleCalendarClient;
  constructor(
    db: PrismaService,
    cache: CacheService,
    client: GoogleCalendarClient,
  ) {
    this.db = db;
    this.cache = cache;
    this.client = client;
  }
  private config() {
    const c = calendarConfig();
    if (!c.enabled)
      throw new ServiceUnavailableException('Google Calendar disabled');
    return c;
  }
  async status() {
    const c = calendarConfig();
    if (!c.enabled) return { enabled: false, connected: false };
    const credential = await this.db.organizerCredential.findUnique({
      where: { id: credentialId },
      select: { email: true, clientId: true },
    });
    const connected =
      credential?.email === c.email && credential?.clientId === c.clientId;
    return {
      enabled: true,
      connected,
      ...(connected ? { organizerEmail: credential.email } : {}),
    };
  }
  async connect(session: string) {
    const c = this.config(),
      state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url');
    await this.cache.set(
      `calendar:oauth:${hash(state)}:${hash(session)}`,
      verifier,
      600,
    );
    const query = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: 'code',
      scope: `${CALENDAR_SCOPE} openid email`,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      login_hint: c.email!,
    });
    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
    };
  }
  async callback(
    session: string,
    state: unknown,
    code: unknown,
    error: unknown,
  ) {
    const c = this.config();
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state))
      throw new BadRequestException('Invalid OAuth state');
    const verifier = await this.cache.consume(
      `calendar:oauth:${hash(state)}:${hash(session)}`,
    );
    if (!verifier)
      throw new BadRequestException('Invalid or expired OAuth state');
    if (error || typeof code !== 'string' || !code || code.length > 4096)
      throw new BadRequestException('Google authorization was not completed');
    const identity = await this.client.exchange(code, verifier);
    const existing = await this.db.organizerCredential.findUnique({
      where: { id: credentialId },
      select: { email: true },
    });
    if (existing && existing.email !== identity.email)
      throw new ConflictException(
        'The company organizer account cannot be changed by reconnecting',
      );
    await this.db.organizerCredential.upsert({
      where: { id: credentialId },
      create: {
        id: credentialId,
        email: identity.email,
        clientId: c.clientId,
        encryptedRefreshToken: new VerificationSecret(c.encryptionKey).seal(
          identity.refreshToken,
          credentialId,
        ),
      },
      update: {
        email: identity.email,
        clientId: c.clientId,
        encryptedRefreshToken: new VerificationSecret(c.encryptionKey).seal(
          identity.refreshToken,
          credentialId,
        ),
      },
    });
    const target = new URL('/admin/bookings', process.env.FRONTEND_URL!);
    return target.toString();
  }
  private async refreshToken() {
    const c = this.config();
    const credential = await this.db.organizerCredential.findUnique({
      where: { id: credentialId },
    });
    if (
      !credential ||
      credential.email !== c.email ||
      credential.clientId !== c.clientId
    )
      throw new ServiceUnavailableException('Google Calendar not connected');
    try {
      return new VerificationSecret(c.encryptionKey).open(
        credential.encryptedRefreshToken,
        credentialId,
      );
    } catch {
      throw new ServiceUnavailableException(
        'Google Calendar credential unavailable',
      );
    }
  }
  async createMeeting(adminId: string, bookingId: string) {
    this.config();
    // Persist a stable provider ID BEFORE any provider request. It survives a
    // timeout, crash or database rollback after Google accepted the insert.
    await this.db.$transaction(async (tx) => {
      const admin = await tx.user.findUnique({ where: { id: adminId } });
      if (!admin?.active || admin.role !== 'ADMIN')
        throw new ForbiddenException('Admin required');
      await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
      const b = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { reservation: true },
      });
      if (!b) throw new NotFoundException('Booking not found');
      if (
        b.status !== 'PENDING' ||
        b.reservation.requestedStartAt <= new Date()
      )
        throw new ConflictException(
          'Booking must be pending and in the future',
        );
      if (!b.meetingUrl && !b.externalCalendarEventId)
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            externalCalendarEventId: hash(`neotek-google-meet:${bookingId}`),
          },
        });
    });
    return this.db.$transaction(
      async (tx) => {
        // Serialize generation with status transitions and other generation calls.
        await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} FOR UPDATE`;
        const b = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          include: { reservation: true },
        });
        if (b.status !== 'PENDING')
          throw new ConflictException('Booking must be pending');
        if (b.meetingUrl)
          return {
            meetingUrl: b.meetingUrl,
            externalCalendarEventId: b.externalCalendarEventId,
          };
        const meetingUrl = await this.client.createMeeting(
          await this.refreshToken(),
          b.externalCalendarEventId!,
          b,
        );
        await tx.booking.update({
          where: { id: bookingId },
          data: { meetingUrl },
        });
        return {
          meetingUrl,
          externalCalendarEventId: b.externalCalendarEventId,
        };
      },
      { maxWait: 5000, timeout: 25000 },
    );
  }
  async cancelEvent(eventId: string) {
    try {
      await this.client.deleteEvent(await this.refreshToken(), eventId);
    } catch {
      this.logger.warn(
        'Google Calendar cleanup failed; booking remains cancelled',
      );
    }
  }
}
