import 'dotenv/config';
import { PrismaClient, UserRole } from '@prisma/client';
import { hashPassword } from '../src/auth/password.util';

async function main(): Promise<void> {
  const email = (process.env.ADMIN_BOOTSTRAP_EMAIL ?? process.argv[2] ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD are required for admin:create',
    );
  }
  if (password.length < 12 || password.length > 256) {
    throw new Error('Admin password must be between 12 and 256 characters');
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      throw new Error('An account with this email already exists');
    }
    await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(password),
        role: UserRole.ADMIN,
      },
    });
    console.log(`Admin account created for ${email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
