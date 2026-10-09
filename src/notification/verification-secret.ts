import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Durable verification mail needs the bearer token to survive a restart. Only
// its SHA-256 hash is stored in the token table; the outbox stores AES-GCM text.
export class VerificationSecret {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== base64Key)
      throw new Error(
        'Verification encryption key must be canonical base64 for 32 bytes',
      );
  }
  seal(token: string, verificationId: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(verificationId));
    const encrypted = Buffer.concat([
      cipher.update(token, 'utf8'),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), encrypted]
      .map((b) => b.toString('base64url'))
      .join('.');
  }
  open(value: string, verificationId: string): string {
    const [iv, tag, encrypted] = value
      .split('.')
      .map((part) => Buffer.from(part, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(verificationId));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString(
      'utf8',
    );
  }
}
