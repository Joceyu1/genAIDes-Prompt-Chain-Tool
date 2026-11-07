# Chainlab — genAIDes Prompt Chain Tool

A private prompt chain studio for superadmins. Built with Next.js, React, TypeScript, Supabase Auth/Postgres/Storage, and OpenAI.

## Features

- Create, edit, search, filter, and delete prompt chains.
- Add, edit, delete, and reorder prompt steps by dragging or keyboard-accessible arrows.
- Run sequential text and image generation with original text/image input.
- Reference `{{input}}`, `{{previous}}`, and earlier outputs such as `{{step.1}}` in prompts.
- View each chain’s run history, partial results, text outputs, and private generated images.
- Light, dark, and system themes, responsive layouts, and an image-to-captions example chain.
- Server-side authorization and guarded database functions require an authenticated profile with `is_superadmin = true`. There is no demo or client-side permission bypass.

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

The linked shared project already has assignment chain tables. Run [supabase/install-existing-chain-admin.sql](supabase/install-existing-chain-admin.sql) once in that project's SQL editor. This is the installer for the current application. It checks the existing schema, installs the current-user authorization function if missing, and adds scoped administration functions, step display settings, model lookup, and private run history. It preserves existing chain/step IDs, model assignments, constraints, profile policies, and records. It grants no account a new role.

The installer uses one transaction and aborts on incompatible tables or conflicting Chainlab objects. If the earlier authorization-only repair is already installed, its definition and owner must pass the installer's checks; the function is not replaced. After a successful installation, use reviewed incremental migrations instead of rerunning the installer. Do not run every file in the migrations directory: the older `setup.sql` and `20261102000000_prompt_chains.sql` describe a different initial schema and are retained as historical references, not the current installation path.

The API calls the no-argument `chainlab_is_superadmin()` function to check the authenticated user's own flag. This function returns only a boolean and is executable by authenticated users only. It uses a fixed search path and a trusted database owner so a separate application's restrictive domain policy cannot hide an already-approved superadmin flag. Existing policies such as `columbia_profiles_guard` continue to govern direct profile reads; the app does not remove or weaken them. No service-role credential is used by the application.

Regenerate the current installer with `node scripts/build-supabase-setup.mjs --existing`. Add `--check` to detect a stale artifact. The `--repair` mode generates the smaller authorization-only repair; it does not install chain editing or generation history.

With `SUPABASE_ACCESS_TOKEN` supplied securely, the optional Management API helper inspects schema metadata without reading application rows:

```bash
node --use-env-proxy scripts/configure-supabase.mjs
```

The helper targets this exact project. Its legacy `--apply` mode intentionally stops against the existing assignment tables; use the current SQL installer above. The application uses the private `chainlab-generated-media` bucket and leaves existing storage buckets and policies unchanged. Sign-in supports existing Supabase email/password and Google accounts; no public registration form is exposed. Both paths require an existing profile whose ID matches the authenticated account and whose `is_superadmin` flag is true. Account provisioning and role assignment remain with the project's trusted administrator.

### Google sign-in

Enable Google in Supabase Authentication → Sign In / Providers. Under Authentication → URL Configuration, add this exact redirect URL while preserving the existing project's URLs and Site URL:

```text
https://genaides-prompt-chain-tool.vercel.app/auth/callback
```

For local development, also allow `http://localhost:3000/auth/callback`. Preview deployments require their own allowed callback URLs. Google sign-in uses PKCE with a cookie verifier, exchanges the authorization code server-side, and checks `profiles.is_superadmin` before returning to the workspace. It never accepts arbitrary callback return URLs. An expired exchange, cancelled login, or profile-access failure returns to sign-in with a specific error. A Google-only account does not automatically have an email/password credential.

## Generation

Editing follows the existing assignment limits: chain names up to 120 characters, descriptions and step templates up to 2,000 characters, and up to 1,000 step positions. Reordering preserves step IDs and the existing unique position constraint. A chain occupying all 1,000 positions needs one step removed before a nontrivial reorder.

Text models: `gpt-4.1-mini`, `gpt-4.1`, and `gpt-4o-mini`. Image model: `gpt-image-1`. Existing registry assignments retain their UUIDs and roles. Models from other providers, inactive models, and unsupported model keys remain editable but cannot run through this OpenAI integration. A step without a registry assignment can use a supported workspace fallback model. The account behind `AI_API_KEY` needs access to the selected model and available quota. Calls incur provider usage costs. Uploaded images can be analyzed by text steps; image steps create or edit images, which can feed subsequent steps.

OpenAI API usage is billed separately from ChatGPT subscriptions. If generation reports an exhausted quota, check [API Billing](https://platform.openai.com/settings/organization/billing/overview), available credits, and the account's usage limits. For a request rate limit, wait before retrying. The app distinguishes recognized quota and rate-limit responses; unrecognized responses use a general limit message. Raw provider error messages, which can contain prompts or credentials, are never shown or saved.

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
