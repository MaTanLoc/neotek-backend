export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const openingBlockComment = /<!--\s*wp:[^>]*-->\s*n?/gi;
const closingBlockComment = /n?\s*<!--\s*\/wp:[^>]*-->/gi;

export function normalizeMigratedString(value: string): string {
  return value
    .replace(openingBlockComment, '')
    .replace(closingBlockComment, '')
    .trim();
}

export function normalizeMigratedContent<T>(value: T): T {
  if (typeof value === 'string') {
    return normalizeMigratedString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeMigratedContent(item)) as T;
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeMigratedContent(item),
      ]),
    ) as T;
  }

  return value;
}

export function collectNumericMediaReferences(
  value: unknown,
  path = '$',
): Array<{ path: string; value: string }> {
  if (
    typeof value === 'string' &&
    /^\d+$/.test(value) &&
    /(?:image|avatar|media|url)$/i.test(path)
  ) {
    return [{ path, value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectNumericMediaReferences(item, `${path}[${index}]`),
    );
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      collectNumericMediaReferences(item, `${path}.${key}`),
    );
  }

  return [];
}
