import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
const mocks = vi.hoisted(() => ({ server: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/server")>()),
  supabaseServer: mocks.server,
}));
import { POST as login } from "../app/api/auth/login/route";
import { POST as google } from "../app/api/auth/google/route";
import { GET as callback } from "../app/auth/callback/route";
const context = { params: Promise.resolve({}) };
function client(flag: boolean | null = true, profileError: unknown = null) {
  const db = {
    auth: {
      signInWithOAuth: vi.fn().mockResolvedValue({
        data: {
          url: "https://example.supabase.co/auth/v1/authorize?provider=google",
        },
        error: null,
      }),
      signInWithPassword: vi.fn().mockResolvedValue({
        data: { user: { id: "user", email: "admin@example.test" } },
        error: null,
      }),
      exchangeCodeForSession: vi
        .fn()
        .mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    rpc: vi.fn().mockResolvedValue({ data: flag, error: profileError }),
  };
  mocks.server.mockResolvedValue(db);
  return db;
}
const post = (path: string, body?: unknown) =>
  new Request(`https://app.example${path}`, {
    method: "POST",
    headers: {
      origin: "https://app.example",
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
beforeEach(() => mocks.server.mockReset());
describe("sign-in routes", () => {
  it("starts Google PKCE with this application callback, without browser redirection on the server", async () => {
    const db = client();
    const result = await google(post("/api/auth/google"), context);
    expect(result.status).toBe(200);
    expect(db.auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: {
        redirectTo: "https://app.example/auth/callback",
        skipBrowserRedirect: true,
        queryParams: { prompt: "select_account" },
      },
    });
    expect((await result.json()).url).toContain("provider=google");
  });
  it("rejects foreign-origin OAuth initiation", async () => {
    const r = await google(
      new Request("https://app.example/api/auth/google", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      }),
      context,
    );
    expect(r.status).toBe(403);
    expect(mocks.server).not.toHaveBeenCalled();
  });
  it("the real Supabase SSR client creates a verifier cookie and S256 challenge", async () => {
    const written: { name: string; value: string }[] = [];
    const db = createServerClient(
      "https://example.supabase.co",
      "public-fixture",
      {
        cookies: {
          getAll: () => [],
          setAll: (entries) => {
            written.push(...entries);
          },
        },
      },
    );
    const { data, error } = await db.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "https://app.example/auth/callback",
        skipBrowserRedirect: true,
      },
    });
    expect(error).toBeNull();
    const url = new URL(data.url!);
    expect(url.searchParams.get("code_challenge_method")).toBe("s256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(
      written.some(
        (c) => c.name.includes("code-verifier") && c.value.length > 20,
      ),
    ).toBe(true);
  });
  it("lets a verified superadmin complete OAuth and ignores arbitrary return URLs", async () => {
    const db = client();
    const result = await callback(
      new Request(
        "https://app.example/auth/callback?code=test-code&next=https://attacker.example",
      ),
    );
    expect(db.auth.exchangeCodeForSession).toHaveBeenCalledWith("test-code");
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe("https://app.example/");
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
  it.each([false, null])(
    "signs out OAuth users without a verified superadmin profile (%s)",
    async (flag) => {
      const db = client(flag);
      const result = await callback(
        new Request("https://app.example/auth/callback?code=test-code"),
      );
      expect(db.auth.signOut).toHaveBeenCalledOnce();
      expect(result.headers.get("location")).toContain(
        "auth_error=superadmin_required",
      );
    },
  );
  it("fails closed on profile database errors after OAuth", async () => {
    const db = client(true, { code: "42501" });
    const result = await callback(
      new Request("https://app.example/auth/callback?code=test-code"),
    );
    expect(db.auth.signOut).toHaveBeenCalledOnce();
    expect(result.headers.get("location")).toContain(
      "auth_error=profile_unavailable",
    );
  });
  it("handles cancelled or expired OAuth callbacks", async () => {
    const missing = await callback(
      new Request("https://app.example/auth/callback?error=access_denied"),
    );
    expect(missing.headers.get("location")).toContain(
      "auth_error=oauth_cancelled",
    );
    const db = client();
    db.auth.exchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: { code: "bad_code" },
    } as never);
    const expired = await callback(
      new Request("https://app.example/auth/callback?code=expired"),
    );
    expect(expired.headers.get("location")).toContain(
      "auth_error=oauth_session",
    );
  });
  it("password sign-in also enforces the shared superadmin check", async () => {
    const db = client(false);
    const response = await login(
      post("/api/auth/login", {
        email: "member@example.test",
        password: "fixture-only",
      }),
      context,
    );
    expect(response.status).toBe(403);
    expect(db.auth.signOut).toHaveBeenCalledOnce();
  });
  it.each([
    [{ status: 400, code: "invalid_credentials" }, 401, "Google"],
    [{ status: 400, code: "email_not_confirmed" }, 403, "Confirm your email"],
    [{ status: 429, code: "over_request_rate_limit" }, 429, "Too many"],
    [{ status: 503, code: "unexpected_failure" }, 503, "unavailable"],
  ])(
    "distinguishes password/provider errors (%j)",
    async (error, status, text) => {
      const db = client();
      db.auth.signInWithPassword.mockResolvedValue({
        data: { user: null },
        error,
      } as never);
      const result = await login(
        post("/api/auth/login", {
          email: "admin@example.test",
          password: "fixture-only",
        }),
        context,
      );
      expect(result.status).toBe(status);
      expect((await result.json()).error).toContain(text);
    },
  );
});
