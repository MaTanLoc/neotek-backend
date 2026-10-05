import { UserRole } from '@prisma/client';

export type SafeUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

export type SessionData = {
  userId: string;
  role: UserRole;
  createdAt: string;
  lastSeenAt: string;
};

export type AuthenticatedRequest = {
  cookies?: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: SafeUser;
};
