import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';
import { OriginGuard } from '../auth/origin.guard';
import {
  CustomerGuard,
  CustomerMutationGuard,
  CustomerRequest,
} from '../customer/customer.guards';
import { CustomerSessionService } from '../customer/customer-session.service';
import { parseInput } from './booking-domain';
import { BookingService } from './booking.service';

export const PUBLIC_RESOURCE = 'neotek-consultation';
@Controller('booking')
export class BookingController {
  private readonly bookings: BookingService;
  private readonly sessions: CustomerSessionService;
  constructor(bookings: BookingService, sessions: CustomerSessionService) {
    this.bookings = bookings;
    this.sessions = sessions;
  }
  @Get('availability')
  async availability(@Query() input: unknown, @Req() req: Request) {
    await this.sessions.rate(req.ip ?? 'unknown', 'availability', 120);
    const data = parseInput(
      z
        .object({
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
          duration: z.coerce.number().int(),
        })
        .strict(),
      input,
    );
    return this.bookings.availability(
      PUBLIC_RESOURCE,
      new Date(data.from),
      new Date(data.to),
      data.duration,
    );
  }
  @Get('options')
  options() {
    return this.bookings.options();
  }
  @Get('hold')
  @UseGuards(CustomerGuard)
  hold(@Req() req: CustomerRequest) {
    return this.bookings.currentHold(req.customer);
  }
  @Post('hold')
  @HttpCode(200)
  @UseGuards(CustomerGuard, OriginGuard, CustomerMutationGuard)
  async acquire(@Body() input: unknown, @Req() req: CustomerRequest) {
    const data = parseInput(
      z
        .object({
          requestedStartAt: z.string().max(40),
          requestedEndAt: z.string().max(40),
          moduleKey: z.string().max(120),
          idempotencyKey: z.string().max(80),
        })
        .strict(),
      input,
    );
    const hold = await this.bookings.acquireHold(req.customer, {
      ...data,
      resourceKey: PUBLIC_RESOURCE,
      timezone: this.bookings.policy.timezone,
    });
    return this.bookings.holdView(hold);
  }
  @Post('holds/:id/release')
  @HttpCode(200)
  @UseGuards(CustomerGuard, OriginGuard, CustomerMutationGuard)
  release(@Param('id') id: string, @Req() req: CustomerRequest) {
    return this.bookings.releaseHold(req.customer, id);
  }
  @Post('finalize')
  @HttpCode(200)
  @UseGuards(CustomerGuard, OriginGuard, CustomerMutationGuard)
  async finalize(@Body() input: unknown, @Req() req: CustomerRequest) {
    const booking = await this.bookings.finalize(req.customer, input);
    return this.bookings.ownBooking(req.customer, booking.id);
  }
  @Get('mine')
  @UseGuards(CustomerGuard)
  mine(@Req() req: CustomerRequest, @Query() query: unknown) {
    const { page, period, from, to } = parseInput(
      z
        .object({
          page: z.coerce.number().int().min(1).max(10000).default(1),
          period: z.enum(['upcoming', 'past']).optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
        })
        .strict(),
      query,
    );
    return this.bookings.ownBookings(req.customer, page, period, { from, to });
  }
  @Get('mine/:id')
  @UseGuards(CustomerGuard)
  own(@Req() req: CustomerRequest, @Param('id') id: string) {
    return this.bookings.ownBooking(req.customer, id);
  }
}
