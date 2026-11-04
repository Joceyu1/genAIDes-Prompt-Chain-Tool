import { describe, expect, it, vi } from "vitest";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

const projectUrl = "https://session-contract-fixture.supabase.co";
const publicKey = "sb_publishable_fixture_only_not_a_real_key";
const userId = "11111111-2222-4333-8444-555555555555";
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
// This token has no valid signature and is used only with the fake fetch below.
const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
  sub: userId,
  aud: "authenticated",
  role: "authenticated",
  iss: `${projectUrl}/auth/v1`,
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.fixture_signature_not_valid`;

function sessionFixture() {
  const user = {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email: "admin@session-fixture.example",
    app_metadata: { provider: "google", providers: ["google"] },
    // Exercise Supabase's real multi-cookie chunk serialization and restoration.
    user_metadata: { fixture: "fixture-only-".repeat(650) },
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const jar = new Map<string, string>();
  const writes: Array<{
    name: string;
    value: string;
    options: CookieOptions;
  }> = [];
  const requests: Array<{ pathname: string; authorization: string | null }> =
    [];
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const fakeFetch = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== projectUrl)
      throw new Error("Unexpected destination in the session contract test");
    requests.push({
      pathname: url.pathname,
      authorization: request.headers.get("authorization"),
    });
    if (url.pathname === "/auth/v1/token") {
      expect(url.searchParams.get("grant_type")).toBe("pkce");
      const body = await request.json();
      expect(body.auth_code).toBe("fixture-authorization-code");
      expect(body.code_verifier).toEqual(expect.any(String));
      expect(body.code_verifier.length).toBeGreaterThan(20);
      return json({
        access_token: accessToken,
        refresh_token: "fixture-refresh-token-not-a-credential",
        expires_in: 3600,
        token_type: "bearer",
        user,
      });
    }
    if (url.pathname === "/auth/v1/user") return json(user);
    if (url.pathname === "/rest/v1/rpc/chainlab_is_superadmin") {
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({});
      return json(true);
    }
    throw new Error("Unexpected network request in session contract test");
  });
  const client = () =>
    createServerClient(projectUrl, publicKey, {
      global: { fetch: fakeFetch },
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: async (values) => {
          // Confirm the SDK awaits cookie writes rather than merely scheduling them.
          await new Promise((resolve) => setTimeout(resolve, 2));
          for (const { name, value, options } of values) {
            writes.push({ name, value, options });
            if (options.maxAge === 0) jar.delete(name);
            else jar.set(name, value);
          }
        },
      },
    });
  return { client, jar, writes, requests, fakeFetch };
}

async function signIn(fixture: ReturnType<typeof sessionFixture>) {
  const startingClient = fixture.client();
  const oauth = await startingClient.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: "https://app-fixture.example/auth/callback",
      skipBrowserRedirect: true,
    },
  });
  expect(oauth.error).toBeNull();
  expect(oauth.data.url).toContain("code_challenge=");
  expect(
    [...fixture.jar.keys()].some((key) => key.includes("code-verifier")),
  ).toBe(true);
  expect(fixture.fakeFetch).not.toHaveBeenCalled();
  const callbackClient = fixture.client();
  const result = await callbackClient.auth.exchangeCodeForSession(
    "fixture-authorization-code",
  );
  expect(result.error).toBeNull();
  expect(result.data.user?.id).toBe(userId);
  return callbackClient;
}

describe("real Supabase SSR OAuth session contract", () => {
  it("uses the newly exchanged user access token for the immediate administrator check", async () => {
    const fixture = sessionFixture();
    const callbackClient = await signIn(fixture);
    const profile = await callbackClient.rpc("chainlab_is_superadmin");
    expect(profile.error).toBeNull();
    expect(profile.data).toBe(true);
    expect(
      fixture.requests.find(
        (r) => r.pathname === "/rest/v1/rpc/chainlab_is_superadmin",
      ),
    ).toMatchObject({ authorization: `Bearer ${accessToken}` });
    expect(fixture.requests.at(-1)?.authorization).not.toBe(
      `Bearer ${publicKey}`,
    );
    expect(
      [...fixture.jar.keys()].filter((key) => !key.includes("code-verifier"))
        .length,
    ).toBeGreaterThan(1);
    // The callback uses the SDK's legacy fixed verifier slot. New auth-js
    // versions retain independent flow slots when that fallback is consumed.
    expect(
      fixture.jar.has("sb-session-contract-fixture-auth-token-code-verifier"),
    ).toBe(false);
  });

  it("restores the exchanged user token from chunked cookies in a fresh request client", async () => {
    const fixture = sessionFixture();
    await signIn(fixture);
    const nextRequestClient = fixture.client();
    const identity = await nextRequestClient.auth.getUser();
    expect(identity.error).toBeNull();
    expect(identity.data.user?.id).toBe(userId);
    const profile = await nextRequestClient.rpc("chainlab_is_superadmin");
    expect(profile.error).toBeNull();
    expect(profile.data).toBe(true);
    expect(
      fixture.requests.filter((r) =>
        ["/auth/v1/user", "/rest/v1/rpc/chainlab_is_superadmin"].includes(
          r.pathname,
        ),
      ),
    ).toEqual([
      { pathname: "/auth/v1/user", authorization: `Bearer ${accessToken}` },
      {
        pathname: "/rest/v1/rpc/chainlab_is_superadmin",
        authorization: `Bearer ${accessToken}`,
      },
    ]);
  });
});
