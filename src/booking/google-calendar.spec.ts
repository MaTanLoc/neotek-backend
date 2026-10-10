/* global afterEach */
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
const Response = globalThis.Response;
import { GoogleCalendarClient } from './google-calendar.client';
import { GoogleCalendarService } from './google-calendar.service';
import { calendarConfig, CALENDAR_SCOPE } from './google-calendar.config';
import { VerificationSecret } from '../notification/verification-secret';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

const fixture = () => ({
  GOOGLE_CALENDAR_ENABLED: 'true',
  GOOGLE_CALENDAR_CLIENT_ID: 'organizer.apps.googleusercontent.com',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'secret-fixture',
  GOOGLE_CALENDAR_REDIRECT_URI:
    'http://localhost:3000/api/integrations/google/calendar/callback',
  GOOGLE_CALENDAR_ORGANIZER_EMAIL: 'organizer@example.test',
  GOOGLE_CALENDAR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  FRONTEND_URL: 'http://localhost:5173',
});

describe('Calendar organizer config and OAuth', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, ...fixture() };
  });
  afterEach(() => {
    process.env = original;
    jest.restoreAllMocks();
  });
  it('validates enabled configuration without leaking secrets; disabled needs no credentials', () => {
    expect(calendarConfig({ GOOGLE_CALENDAR_ENABLED: 'false' }).enabled).toBe(
      false,
    );
    expect(() => calendarConfig({ GOOGLE_CALENDAR_ENABLED: 'true' })).toThrow(
      'GOOGLE_CALENDAR_CLIENT_ID',
    );
    expect(() =>
      calendarConfig({
        ...fixture(),
        GOOGLE_CUSTOMER_CLIENT_ID: 'organizer.apps.googleusercontent.com',
      }),
    ).toThrow('separate OAuth client');
    expect(() =>
      calendarConfig({
        ...fixture(),
        GOOGLE_CALENDAR_REDIRECT_URI: 'https://evil.test/callback',
      }),
    ).toThrow('exact backend callback');
    expect(() =>
      calendarConfig({ ...fixture(), NODE_ENV: 'production' }),
    ).toThrow('HTTPS');
    expect(() =>
      calendarConfig({ ...fixture(), GOOGLE_CALENDAR_ENCRYPTION_KEY: 'wrong' }),
    ).toThrow('base64');
  });
  function setup() {
    const state = new Map<string, string>();
    const cache = {
      set: jest.fn(async (k: string, v: string) => {
        state.set(k, v);
      }),
      consume: jest.fn(async (k: string) => {
        const v = state.get(k) ?? null;
        state.delete(k);
        return v;
      }),
    };
    const db = {
      organizerCredential: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const client = {
      exchange: jest.fn().mockResolvedValue({
        refreshToken: 'secret-refresh-token',
        email: 'organizer@example.test',
      }),
    };
    const service = new GoogleCalendarService(
      db as unknown as PrismaService,
      cache as unknown as CacheService,
      client as unknown as GoogleCalendarClient,
    );
    return { service, db, cache, client };
  }
  it('uses offline access, PKCE, minimal event scope and session-bound one-use state; encrypts credentials', async () => {
    const { service, db, client } = setup();
    const result = await service.connect('session-a');
    const url = new URL(result.authorizationUrl),
      state = url.searchParams.get('state');
    expect(url.searchParams.get('scope')).toBe(
      `${CALENDAR_SCOPE} openid email`,
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    await expect(
      service.callback('session-b', state, 'code', undefined),
    ).rejects.toThrow('state');
    expect(client.exchange).not.toHaveBeenCalled();
    expect(await service.callback('session-a', state, 'code', undefined)).toBe(
      'http://localhost:5173/admin/bookings',
    );
    const saved = db.organizerCredential.upsert.mock.calls[0][0].create;
    expect(JSON.stringify(saved)).not.toContain('secret-refresh-token');
    expect(
      new VerificationSecret(process.env.GOOGLE_CALENDAR_ENCRYPTION_KEY!).open(
        saved.encryptedRefreshToken,
        saved.id,
      ),
    ).toBe('secret-refresh-token');
    await expect(
      service.callback('session-a', state, 'code', undefined),
    ).rejects.toThrow('state');
    expect(client.exchange).toHaveBeenCalledTimes(1);
  });
  it('exchange failure/denied consent never persists credentials; disabled fails cleanly', async () => {
    const { service, db, client } = setup();
    await expect(
      service.callback('a', 'wrong', 'code', undefined),
    ).rejects.toThrow('state');
    let state = new URL(
      (await service.connect('a')).authorizationUrl,
    ).searchParams.get('state');
    await expect(
      service.callback('a', state, undefined, 'access_denied'),
    ).rejects.toThrow('not completed');
    state = new URL(
      (await service.connect('a')).authorizationUrl,
    ).searchParams.get('state');
    client.exchange.mockRejectedValue(new Error('sanitized boundary failure'));
    await expect(
      service.callback('a', state, 'code', undefined),
    ).rejects.toThrow();
    expect(db.organizerCredential.upsert).not.toHaveBeenCalled();
    process.env.GOOGLE_CALENDAR_ENABLED = 'false';
    expect(await service.status()).toEqual({
      enabled: false,
      connected: false,
    });
    await expect(service.connect('a')).rejects.toThrow('disabled');
    await expect(service.createMeeting('admin', 'booking')).rejects.toThrow(
      'disabled',
    );
  });
});

describe('Google Calendar transport boundary', () => {
  const original = process.env;
  beforeEach(() => {
    process.env = { ...original, ...fixture() };
  });
  afterEach(() => {
    process.env = original;
    jest.restoreAllMocks();
  });
  const booking = {
    id: 'booking',
    solutionLabel: 'ERP',
    reservation: {
      requestedStartAt: new Date('2027-01-01T02:00:00Z'),
      requestedEndAt: new Date('2027-01-01T03:00:00Z'),
      timezone: 'Asia/Ho_Chi_Minh',
    },
  };
  const event = {
    id: 'abc123',
    organizer: { email: 'organizer@example.test' },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
  it('a timeout after accepted insertion is recovered by the same event ID without reinsertion', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({}, 404))
      .mockRejectedValueOnce(new Error('timeout after Google accepted'))
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json(event));
    const client = new GoogleCalendarClient();
    await expect(
      client.createMeeting('refresh', 'abc123', booking),
    ).rejects.toThrow('unavailable');
    await expect(
      client.createMeeting('refresh', 'abc123', booking),
    ).resolves.toBe(event.hangoutLink);
    expect(
      transport.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/events?') && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });
  it('inserts with fixed ID and conferenceDataVersion=1; omits internal/contact data', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json(event));
    expect(
      await new GoogleCalendarClient().createMeeting(
        'refresh',
        'abc123',
        booking,
      ),
    ).toBe(event.hangoutLink);
    const [url, init] = transport.mock.calls[2];
    expect(String(url)).toContain('conferenceDataVersion=1');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      id: 'abc123',
      summary: 'NeoTek Consultation - ERP',
      conferenceData: { createRequest: { requestId: 'abc123' } },
    });
    expect(JSON.parse(init!.body as string)).not.toHaveProperty('attendees');
    expect(init!.signal).toBeDefined();
  });
  it('recovers existing event without inserting; handles asynchronous conferences and 409', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(
        json({
          id: 'abc123',
          conferenceData: {
            createRequest: { status: { statusCode: 'pending' } },
          },
        }),
      )
      .mockResolvedValueOnce(json(event));
    await new GoogleCalendarClient().createMeeting(
      'refresh',
      'abc123',
      booking,
    );
    expect(
      transport.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1); // refresh only
    transport
      .mockReset()
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json(event));
    await expect(
      new GoogleCalendarClient().createMeeting('refresh', 'abc123', booking),
    ).resolves.toBe(event.hangoutLink);
  });
  it('sanitizes provider failures and network timeout, never returns provider tokens', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ access_token: 'DO-NOT-LEAK' }, 400));
    await expect(
      new GoogleCalendarClient().exchange('code', 'verifier'),
    ).rejects.toThrow('Google Calendar unavailable');
    transport.mockRejectedValue(new Error('DO-NOT-LEAK'));
    await expect(
      new GoogleCalendarClient().createMeeting('refresh', 'abc123', booking),
    ).rejects.toThrow('Google Calendar unavailable');
  });
  it('exchanges server-side and rejects a different organizer or unverified email', async () => {
    const transport = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        json({
          access_token: 'access',
          refresh_token: 'refresh',
          scope: CALENDAR_SCOPE,
        }),
      )
      .mockResolvedValueOnce(
        json({ email: 'organizer@example.test', email_verified: true }),
      );
    await expect(
      new GoogleCalendarClient().exchange('code', 'pkce'),
    ).resolves.toEqual({
      refreshToken: 'refresh',
      email: 'organizer@example.test',
    });
    expect(String(transport.mock.calls[0][1]!.body)).toContain(
      'code_verifier=pkce',
    );
    transport
      .mockReset()
      .mockResolvedValueOnce(
        json({
          access_token: 'access',
          refresh_token: 'refresh',
          scope: CALENDAR_SCOPE,
        }),
      )
      .mockResolvedValueOnce(
        json({ email: 'other@example.test', email_verified: true }),
      );
    await expect(
      new GoogleCalendarClient().exchange('code', 'pkce'),
    ).rejects.toThrow('unavailable');
  });
});
