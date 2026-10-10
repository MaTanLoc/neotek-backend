import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConfiguredEmailProvider } from '../src/notification/email-provider';

// Explicit manual transport check: one recipient, no booking/account/outbox mutation.
async function main() {
  if (process.env.EMAIL_PROVIDER !== 'resend')
    throw new Error('Manual live test requires EMAIL_PROVIDER=resend');
  const recipient = z.email().safeParse(process.env.EMAIL_TEST_TO);
  if (!recipient.success) throw new Error('Set a valid EMAIL_TEST_TO');
  const db = new PrismaClient();
  try {
    const provider = new ConfiguredEmailProvider(db);
    const result = await provider.send({
      template: 'EMAIL_TRANSPORT_TEST',
      recipient: recipient.data,
      locale: 'en',
      payload: {},
      idempotencyKey: `manual-test:${randomUUID()}`,
    });
    console.log(
      `Resend accepted test email: ${result.messageId}. Check the recipient inbox and Resend delivery status.`,
    );
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error(
    'Email test failed. Check EMAIL_PROVIDER, RESEND_API_KEY, EMAIL_FROM, EMAIL_REPLY_TO, EMAIL_TEST_TO and Resend sender permissions. No credentials were logged.',
  );
  process.exitCode = 1;
});
