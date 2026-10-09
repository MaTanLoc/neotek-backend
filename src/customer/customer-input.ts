import { z } from 'zod';

// Registration and recovery deliberately share the authoritative policy.
export const customerPassword = z.string().min(12).max(256);
export const customerEmail = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((value) => value.toLowerCase());
