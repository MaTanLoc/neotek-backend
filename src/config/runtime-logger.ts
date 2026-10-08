import { ConsoleLogger } from '@nestjs/common';

/** Dependency exceptions can contain DSNs, credentials and request values. */
export class RuntimeLogger extends ConsoleLogger {
  error(message: unknown, ...optional: unknown[]): void {
    const safe =
      typeof message === 'string' &&
      /^Request failed status=\d{3} requestId=[a-f0-9-]+$/.test(message)
        ? message
        : 'Runtime dependency or application error; sensitive details withheld';
    const last = optional.at(-1);
    const context =
      typeof last === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(last)
        ? last
        : 'Runtime';
    super.error(safe, context);
  }
}
