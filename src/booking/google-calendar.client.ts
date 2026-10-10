/* global RequestInit */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { URLSearchParams } from 'node:url';
import { calendarConfig } from './google-calendar.config';

type CalendarEvent = {
  id?: string;
  status?: string;
  hangoutLink?: string;
  organizer?: { email?: string };
  conferenceData?: { createRequest?: { status?: { statusCode?: string } } };
};
export type CalendarBooking = {
  id: string;
  solutionLabel: string;
  reservation: {
    requestedStartAt: Date;
    requestedEndAt: Date;
    timezone: string;
  };
};
const unavailable = () =>
  new ServiceUnavailableException(
    'Google Calendar unavailable; use a manual meeting URL',
  );
const AbortSignal = globalThis.AbortSignal;

@Injectable()
export class GoogleCalendarClient {
  // All provider transport is bounded, without automatic retries. Provider bodies
  // and tokens never become exceptions, logs or API responses.
  private async request(url: string, init: RequestInit = {}) {
    try {
      return await globalThis.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      throw unavailable();
    }
  }
  private async read<T>(response: globalThis.Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      throw unavailable();
    }
  }
  async exchange(code: string, verifier: string) {
    const c = calendarConfig();
    const result = await this.token({
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: c.redirectUri,
    });
    if (
      !result.refresh_token ||
      !result.access_token ||
      !result.scope
        ?.split(' ')
        .includes('https://www.googleapis.com/auth/calendar.events')
    )
      throw unavailable();
    const response = await this.request(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { Authorization: `Bearer ${result.access_token}` } },
    );
    if (!response.ok) throw unavailable();
    const identity = await this.read<{
      email?: string;
      email_verified?: boolean;
    }>(response);
    if (!identity.email_verified || identity.email?.toLowerCase() !== c.email)
      throw unavailable();
    return { refreshToken: result.refresh_token, email: c.email! };
  }
  private async token(fields: Record<string, string>) {
    const c = calendarConfig();
    const response = await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        ...fields,
      }).toString(),
    });
    if (!response.ok) throw unavailable();
    try {
      return (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        scope?: string;
      };
    } catch {
      throw unavailable();
    }
  }
  private async access(refreshToken: string) {
    const token = await this.token({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (!token.access_token) throw unavailable();
    return token.access_token;
  }
  async createMeeting(
    refreshToken: string,
    eventId: string,
    booking: CalendarBooking,
  ) {
    const access = await this.access(refreshToken);
    const headers = {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    };
    const base =
      'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    const url = `${base}/${eventId}`;
    let response = await this.request(url, { headers });
    if (response.status === 404) {
      response = await this.request(
        `${base}?conferenceDataVersion=1&sendUpdates=none`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            id: eventId,
            summary: `NeoTek Consultation - ${booking.solutionLabel}`,
            description: `NeoTek booking ${booking.id}`,
            start: {
              dateTime: booking.reservation.requestedStartAt.toISOString(),
              timeZone: booking.reservation.timezone,
            },
            end: {
              dateTime: booking.reservation.requestedEndAt.toISOString(),
              timeZone: booking.reservation.timezone,
            },
            conferenceData: {
              createRequest: {
                requestId: eventId,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          }),
        },
      );
      if (response.status === 409)
        response = await this.request(url, { headers });
    }
    if (!response.ok) throw unavailable();
    let event = await this.read<CalendarEvent>(response);
    // Meet provisioning can be asynchronous. One bounded read; subsequent user
    // retries recover the same event instead of inserting another.
    if (
      !event.hangoutLink &&
      event.conferenceData?.createRequest?.status?.statusCode === 'pending'
    ) {
      response = await this.request(url, { headers });
      if (!response.ok) throw unavailable();
      event = await this.read<CalendarEvent>(response);
    }
    if (
      event.id !== eventId ||
      event.status === 'cancelled' ||
      event.organizer?.email?.toLowerCase() !== calendarConfig().email ||
      !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(
        event.hangoutLink ?? '',
      )
    )
      throw unavailable();
    return event.hangoutLink!;
  }
  async deleteEvent(refreshToken: string, eventId: string) {
    const access = await this.access(refreshToken);
    const response = await this.request(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${access}` } },
    );
    if (!response.ok && ![404, 410].includes(response.status))
      throw unavailable();
  }
}
