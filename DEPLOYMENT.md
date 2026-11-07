# Deploying the prompt chain tool

Use the existing GitHub repository `Joceyu1/genAIDes-Prompt-Chain-Tool` and the existing Vercel project https://vercel.com/jocelyn13/genaides-prompt-chain-tool. No replacement repository or project is needed. Writing these instructions does not deploy the app or change Vercel protection.

## Required account access

- GitHub credentials need write access to the selected repository and permission to push workflow files when updating `.github/workflows`. The Vercel integration separately needs access to read that repository. Allow `api.github.com` for metadata requests.
- Store `VERCEL_TOKEN` securely in environment settings. The helper resolves the exact `jocelyn13` scope by matching the token account's username or an accessible team slug. It never falls back to another personal account. If using `VERCEL_TEAM_ID`, that team's slug must also match `jocelyn13`.
- The Vercel GitHub integration must have access to the selected repository. Connect it under Project Settings → Git if the existing project has no Git connection.
- Management requires `api.vercel.com`; AI generation requires `api.openai.com`; authentication, database, and storage require the Supabase project hostname. A saved network draft does not establish that the runtime policy has applied.

Never commit credentials to Git or paste them into chat. Do not put the Vercel deployment token into the application runtime.

## Prepare production

1. For this linked project with existing assignment tables, run `supabase/install-existing-chain-admin.sql` once in its Supabase SQL editor. It installs the current-user authorization check, scoped chain/step operations, model lookup, and private run history in one transaction. It validates an existing authorization-only repair or creates the role function if missing. Existing chain records, constraints, profile policies, and role assignments are preserved. Existing accounts must have `profiles.id = auth.uid()` and `profiles.is_superadmin = true`. Do not apply the older fresh-schema setup or all dated migration files to this project. Conflicting Chainlab objects abort the installer; after success, use reviewed incremental migrations. For a workspace already installed before Gemini support, apply only `supabase/enable-gemini.sql` to enable Gemini workspace models.
2. Configure these application environment variables in Vercel for Production and Preview:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - Server-only `GEMINI_API_KEY` (or `GOOGLE_API_KEY` fallback) for Gemini text/image-analysis steps
   - Optional server-only `AI_API_KEY` (or `OPENAI_API_KEY` fallback) for explicitly selected paid OpenAI text/image models

   If the public Supabase configuration is already available in the local process, the helper can transfer only those public values:

   ```sh
   node --use-env-proxy scripts/configure-vercel.mjs --apply --sync-public-env
   ```

   This explicit flag upserts the public URL and anon/publishable key for Production and Preview. It validates that the key is public, rejects service-role/secret keys and proxy placeholders, and never prints values. Add provider keys directly and securely in Vercel: a proxy-backed cloud secret placeholder must never be copied into Vercel as a credential. Choose a Google AI Studio project on the Free tier for Gemini; model and regional availability and quotas still apply. The deployment helper checks that at least one provider's variable name is present. Each run separately checks every selected provider's credentials before creating history or calling a provider.

3. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and the browser tests. Push the reviewed code to the existing repository. No new repository is needed.
4. Inspect the helper's dry run:

   ```sh
   node --use-env-proxy scripts/configure-vercel.mjs
   ```

5. Configure the existing project with credentials supplied securely:

   ```sh
   node --use-env-proxy scripts/configure-vercel.mjs --apply
   ```

   The helper resolves `jocelyn13`, requires the existing `genaides-prompt-chain-tool` project, checks its GitHub connection, disables Vercel Authentication, password protection, and Trusted IP protection, then reads the project back to verify. It fails if the project is missing or linked to another repository. It does not create a project by default or deploy automatically. `--create` is an explicit opt-in for separately authorized future workflows; it is unnecessary for this project.

6. After code, production variables, and the database migration are ready, request a Git-backed deployment:

   ```sh
   SUPABASE_MIGRATION_APPLIED=1 node --use-env-proxy scripts/configure-vercel.mjs --apply --deploy
   ```

   `SUPABASE_MIGRATION_APPLIED=1` is a non-secret deployment-tool confirmation that an operator applied the complete database setup, including the current-user role function; it does not perform or verify setup. The helper checks required Production variable names using encrypted metadata only. It never decrypts or logs their values. Presence of a variable name is not proof that its value works. It reads the GitHub repository ID from the project link, falling back to `gh api`, and deploys `main` (or `DEPLOY_REF` when explicitly set).

The scope, project name, and repository can be overridden by explicit non-secret `VERCEL_SCOPE`, `VERCEL_PROJECT_NAME`, and `GITHUB_REPOSITORY` settings for future projects. The defaults match the supplied link exactly.

## Verify production

Inspect the Vercel build and deployment result, then open the production URL in an Incognito window. Vercel should not show its own authentication wall. The application must still require login and refuse accounts whose `profiles.is_superadmin` is not exactly true. Verify superadmin login, chain and step create/edit/delete, step reordering, generation, per-chain media/run history, and light/dark/system themes. Verify a non-superadmin receives no chain data and cannot call any management or generation endpoint.

A checked-in helper and successful deployment request are not evidence that the app is running. Production database, authentication, storage, and AI generation must be tested with the configured services before claiming completion.

The project-creation (explicit opt-in only), project-update, environment metadata, scope-resolution, and deployment endpoint schemas were checked against official `@vercel/sdk` 1.28.55 models. Live calls still require account access and applied network policy.
