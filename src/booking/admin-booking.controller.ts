import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest } from '../auth/auth.types';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CsrfGuard } from '../auth/csrf.guard';
import { OriginGuard } from '../auth/origin.guard';
import { AdminRateLimitGuard } from '../auth/admin-rate-limit.guard';
import { BookingService } from './booking.service';

@Controller('admin/bookings')
@Roles(UserRole.ADMIN)
@UseGuards(SessionAuthGuard, RolesGuard, AdminRateLimitGuard)
export class AdminBookingController {
  private readonly bookings: BookingService;
  constructor(bookings: BookingService) {
    this.bookings = bookings;
  }
  @Get()
  list(@Query() query: unknown) {
    return this.bookings.adminList(query);
  }
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.bookings.adminDetail(id);
  }
  @Post(':id/status')
  @UseGuards(CsrfGuard, OriginGuard)
  transition(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.bookings.transition(req.user!.id, id, input);
  }
  @Post(':id/notes')
  @UseGuards(CsrfGuard, OriginGuard)
  note(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.bookings.addNote(req.user!.id, id, input);
  }

  @Post(':id/google-meet')
  @UseGuards(CsrfGuard, OriginGuard)
  googleMeet(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.bookings.createGoogleMeet(req.user!.id, id);
  }
}
