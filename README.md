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

The linked shared project already has assignment chain tables. For the sign-in repair, run only [supabase/repair-superadmin-access.sql](supabase/repair-superadmin-access.sql) once in that project's SQL editor. It installs the current-user role function without adopting or changing existing chain tables, profile policies, or user data. It stops if that function already exists. Existing-schema installations also need their table columns and access rules checked before chain operations can be validated.

For a separate empty database, [supabase/setup.sql](supabase/setup.sql) combines the complete schema migrations into one guarded transaction and refuses to overwrite pre-existing app objects. It preserves profile rows, existing role values, and profile-read policies, adds the chain tables/functions, and prevents untrusted changes to `is_superadmin`. Existing `profiles.id` must match `auth.users.id`. An established migration workflow can instead apply the dated migrations in order. Do not use this fresh-schema script to replace the linked project's assignment tables.

The API calls the no-argument `chainlab_is_superadmin()` function to check the authenticated user's own flag. This function returns only a boolean and is executable by authenticated users only. It uses a fixed search path and a trusted database owner so a separate application's restrictive domain policy cannot hide an already-approved superadmin flag. Existing policies such as `columbia_profiles_guard` continue to govern direct profile reads; the app does not remove or weaken them. No service-role credential is used by the application.

Regenerate the combined SQL after editing its source migrations with `node scripts/build-supabase-setup.mjs`; add `--repair` to regenerate the authorization-only repair. Both modes support `--check` to detect a stale artifact.

With `SUPABASE_ACCESS_TOKEN` supplied securely, the optional Management API helper inspects schema metadata without reading application rows:

```bash
node --use-env-proxy scripts/configure-supabase.mjs
# After inspecting compatibility:
node --use-env-proxy scripts/configure-supabase.mjs --apply
```

The helper targets this exact project and refuses incompatible profiles or pre-existing app objects. Its `--apply` mode is for initial schema setup and intentionally stops against the existing assignment tables. It does not automatically adopt or overwrite another application's tables, functions, policies, or storage bucket. After a successful initial migration, inspect rather than rerun `--apply`.

The setup creates a private `prompt-chain-media` storage bucket and role checks. It never grants a user superadmin access. Use a trusted SQL session to explicitly grant an intended existing account access:

```sql
update public.profiles
set is_superadmin = true
where id = '<existing-auth-user-uuid>';
```

If the intended user has no profile row, create one through your existing profile provisioning process first, including any other fields your project requires. Do not grant this role through a public signup or client-side form. Sign-in supports existing Supabase email/password and Google accounts; no public registration form is exposed. Both paths require the same verified superadmin profile.

### Google sign-in

Enable Google in Supabase Authentication → Sign In / Providers. Under Authentication → URL Configuration, add this exact redirect URL while preserving the existing project's URLs and Site URL:

```text
https://genaides-prompt-chain-tool.vercel.app/auth/callback
```

For local development, also allow `http://localhost:3000/auth/callback`. Preview deployments require their own allowed callback URLs. Google sign-in uses PKCE with a cookie verifier, exchanges the authorization code server-side, and checks `profiles.is_superadmin` before returning to the workspace. It never accepts arbitrary callback return URLs. An expired exchange, cancelled login, or profile-access failure returns to sign-in with a specific error. A Google-only account does not automatically have an email/password credential.

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
