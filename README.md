# Chainlab — genAIDes Prompt Chain Tool

A private prompt chain studio for superadmins. Built with Next.js, React, TypeScript, Supabase Auth/Postgres/Storage, and OpenAI.

## Features

- Create, edit, search, filter, and delete prompt chains.
- Add, edit, delete, and reorder prompt steps by dragging or keyboard-accessible arrows.
- Run sequential text and image generation with original text/image input.
- Reference `{{input}}`, `{{previous}}`, and earlier outputs such as `{{step.1}}` in prompts.
- View each chain’s run history, partial results, text outputs, and private generated images.
- Light, dark, and system themes, responsive layouts, and an image-to-captions example chain.
- Server-side authorization and database RLS require an authenticated profile with `is_superadmin = true`. There is no demo or client-side permission bypass.

## Local development

Requires Node.js 24 and npm. Use the existing checkout; a separate Git worktree is unnecessary.

```bash
npm ci
cp .env.example .env.local
# Fill in NEXT_PUBLIC_SUPABASE_ANON_KEY and AI_API_KEY securely.
npm run dev
```

The public Supabase project is `https://qrgjqpdvvbwmjpthpmlo.supabase.co`. Set the same configuration in Vercel before deploying. No service-role key is used by the application. The public key can also be supplied as `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

## Database setup

Apply [the migration](supabase/migrations/20261102000000_prompt_chains.sql) in the linked project's Supabase SQL editor or your established migration workflow. Review it before applying to an existing shared project: it preserves profile rows and existing role values, adds prompt chain tables/functions, and prevents untrusted changes to `is_superadmin`, including through older permissive profile policies. Existing `profiles.id` must match `auth.users.id`.

With `SUPABASE_ACCESS_TOKEN` supplied securely, the optional Management API helper inspects schema metadata without reading application rows:

```bash
node --use-env-proxy scripts/configure-supabase.mjs
# After inspecting compatibility:
node --use-env-proxy scripts/configure-supabase.mjs --apply
```

The helper targets this exact project and refuses incompatible profiles or pre-existing app objects. It does not automatically adopt or overwrite another application's tables, functions, policies, or storage bucket. After a successful initial migration, inspect rather than rerun `--apply`.

The migration creates a private `prompt-chain-media` storage bucket and a role check. It never grants a user superadmin access. Use a trusted SQL session to explicitly grant an intended existing account access:

```sql
update public.profiles
set is_superadmin = true
where id = '<existing-auth-user-uuid>';
```

If the intended user has no profile row, create one through your existing profile provisioning process first, including any other fields your project requires. Do not grant this role through a public signup or client-side form. The sign-in form uses existing Supabase email/password accounts; no public registration is exposed.

## Generation

Text models: `gpt-4.1-mini`, `gpt-4.1`, and `gpt-4o-mini`. Image model: `gpt-image-1`. The account behind `AI_API_KEY` needs access to the selected model and available quota. Calls incur provider usage costs. Uploaded images can be analyzed by text steps; image steps create or edit images, which can feed subsequent steps.

Runs support up to 10 steps with a 250-second overall provider timeout. Vercel must permit a 300-second function duration; use an appropriate plan/runtime configuration. Runs execute synchronously: leave the page open while a run is processing. Text inputs are capped at 16,000 characters (the UI uses 12,000); browser uploads are capped at 2 MB to fit Vercel's request limits. Server requests additionally validate sizes and formats. Failed runs retain completed steps. History returns the latest 50 runs per chain. Signed image URLs expire after an hour; reload the history to renew them. This version supports text and still images, not audio or video.

## Validation

```bash
npm run typecheck
npm test
npm run test:deployment
npm run build
npx playwright install chromium
npm run test:e2e
```

Unit tests validate authorization, input constraints, provider requests, and prompt substitution. Database tests exercise the actual migration in an embedded PostgreSQL engine, including RLS and role escalation denial. Browser tests use explicitly mocked APIs to verify UI workflows; they do not establish live Supabase or OpenAI connectivity.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for the existing GitHub/Vercel targets, required settings, and the protection configuration helper. Disabling Vercel deployment protection makes the login page accessible in Incognito; application superadmin authentication remains required.
