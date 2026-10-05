# Neotek Backend

Minimal NestJS backend skeleton for the Neotek project.

## Structure

Feature module shells are organized under `src/`:

- `auth`
- `users`
- `pages`
- `sections`
- `media`
- `cache`
- `prisma`
- `health`

Integrations, persistence, authentication, and business logic are intentionally not implemented yet.

## CMS data model

The CMS uses a relational Page → Section structure, with locale-specific translations for page and section content. Stable identities, ordering, status flags, timestamps, users, media, and settings use relational fields; flexible section and setting content uses PostgreSQL JSONB through Prisma `Json`. Translation locales remain strings for future extensibility, and `PageSection.type` is intentionally a string so new section types do not require a database migration.

## Database migrations

```bash
npx prisma migrate dev
npx prisma migrate status
```

## CMS structure seed

```bash
npx prisma db seed
```

Phase 5C creates CMS structure only; it does not import real LocalWP content.

## Public CMS API

```text
GET /api/pages/:slug?locale=vi
```

Public page responses use Redis read-through caching with a 300-second TTL. Cache keys use `cms:page:<slug>:<locale>`.

## LocalWP content import

LocalWP is a migration source only; the importer is not part of the production runtime. Always run the dry-run first.

```bash
npm run import:localwp -- --dry-run
npm run import:localwp
```

Section JSON is validated by registered Zod schemas on import/write boundaries. Unknown section types are rejected; public reads do not revalidate cached or database content.

## Admin authentication

Admin authentication uses Argon2id password hashes and opaque Redis-backed sessions in HttpOnly cookies. Production requires HTTPS; sessions last 8 hours and logout revokes the Redis session. CSRF tokens are server-bound in Redis, required in `X-CSRF-Token` for authenticated writes, and authenticated writes require an exact `FRONTEND_URL` Origin. Login attempts use a Redis-backed five-per-minute IP limiter. There is no public registration. Do not store admin authentication tokens in browser storage.

Bootstrap the first admin operationally by setting `ADMIN_BOOTSTRAP_EMAIL` and `ADMIN_BOOTSTRAP_PASSWORD` (outside the repository), then run:

```bash
npm run admin:create
```

All future state-changing admin endpoints must retain exact-origin CORS and SameSite/CSRF protections.

Login attempts are limited to 5 per minute using a Redis-backed limiter.

## Admin CMS API

Admin routes are under `/api/admin` and require an authenticated Redis session. State-changing requests require a valid `X-CSRF-Token` and exact trusted `Origin`. `ADMIN` users manage pages and structure; `EDITOR` users can edit translations/content and section ordering/toggles but cannot create/archive pages. Section content is validated by the registered Zod schema. Hard deletes are not implemented. Successful content mutations invalidate only affected public page cache keys after the database write; Redis invalidation failures do not fail the database mutation.

## Docker

```bash
docker compose up -d
docker compose ps
docker compose logs
docker compose down
```
