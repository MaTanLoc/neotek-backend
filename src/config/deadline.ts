import { setTimeout, clearTimeout } from 'node:timers';

export async function withDeadline<T>(
  work: Promise<T>,
  milliseconds = 2000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Dependency timeout')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
