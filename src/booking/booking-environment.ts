import { EnvironmentValidationError } from '../config/validate-environment';
import { VerificationSecret } from '../notification/verification-secret';
import { validateEmailConfiguration } from '../notification/email-provider';
import { bookingPolicy } from './booking-policy';
import { passwordResetMinutes } from '../customer/customer-password-recovery.service';

export function validateBookingEnvironment(env = process.env) {
  try {
    new VerificationSecret(env.CUSTOMER_VERIFICATION_ENCRYPTION_KEY ?? '');
    bookingPolicy(env);
    passwordResetMinutes(env);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.BOOKING_ADMIN_EMAIL ?? ''))
      throw new Error('BOOKING_ADMIN_EMAIL is required');
    validateEmailConfiguration(env);
  } catch {
    throw new EnvironmentValidationError(
      'Booking configuration invalid: check verification key, admin email, scheduling policy and email transport',
    );
  }
}
