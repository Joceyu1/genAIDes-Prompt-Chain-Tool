import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  jar: { getAll: vi.fn(() => []), set: vi.fn() },
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: mocks.create }));
vi.mock("next/headers", () => ({ cookies: async () => mocks.jar }));
import {
  ApiError,
  checkOrigin,
  parseId,
  readBody,
  requireAdmin,
  requestOrigin,
  route,
} from "../lib/server";
import { chainSchema } from "../lib/validation";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-test-key");
  mocks.create.mockReset();
});
describe("superadmin authorization", () => {
  it("denies an anonymous session before calling the role function", async () => {
    const db = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: null }, error: null }),
      },
      rpc: vi.fn(),
    };
    mocks.create.mockReturnValue(db);
    await expect(requireAdmin()).rejects.toMatchObject({ status: 401 });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([false, null, "true", [true], { is_superadmin: true }])(
    "denies any role result other than boolean true (%j)",
    async (flag) => {
      const db = {
        auth: {
          getUser: vi
            .fn()
            .mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
        },
        rpc: vi.fn().mockResolvedValue({ data: flag, error: null }),
      };
      mocks.create.mockReturnValue(db);
      await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
      expect(db.rpc).toHaveBeenCalledWith("chainlab_is_superadmin");
    },
  );
  it("allows only a verified user whose own role function returns true", async () => {
    const db = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
      },
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };
    mocks.create.mockReturnValue(db);
    await expect(requireAdmin()).resolves.toMatchObject({
      user: { id: "user" },
    });
    expect(db.auth.getUser).toHaveBeenCalledOnce();
    expect(db.rpc).toHaveBeenCalledWith("chainlab_is_superadmin");
  });
  it.each(["DB_DOWN", "PGRST202", "42501"])(
    "fails closed when the role function fails (%s)",
    async (code) => {
      mocks.create.mockReturnValue({
        auth: {
          getUser: vi
            .fn()
            .mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
        },
        rpc: vi.fn().mockResolvedValue({ data: null, error: { code } }),
      });
      await expect(requireAdmin()).rejects.toMatchObject({ status: 503 });
    },
  );
});
describe("request boundaries", () => {
  it("uses the actual request host when Next binds to 0.0.0.0", () => {
    const request = new Request("http://0.0.0.0:3001/api/auth/google", {
      method: "POST",
      headers: { host: "localhost:3001", origin: "http://localhost:3001" },
    });
    expect(requestOrigin(request)).toBe("http://localhost:3001");
    expect(() => checkOrigin(request)).not.toThrow();
  });
  it("does not trust spoofed forwarded hosts or malformed host values", () => {
    expect(() =>
      checkOrigin(
        new Request("https://app.example/api/auth/google", {
          method: "POST",
          headers: {
            host: "app.example",
            origin: "https://attacker.example",
            "x-forwarded-host": "attacker.example",
          },
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      requestOrigin(
        new Request("https://app.example/", {
          headers: { host: "app.example@attacker.example" },
        }),
      ),
    ).toThrow(ApiError);
  });
  it("rejects missing and foreign origins on mutations", () => {
    expect(() =>
      checkOrigin(
        new Request("https://app.example/api/chains", { method: "POST" }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      checkOrigin(
        new Request("https://app.example/api/chains", {
          headers: { origin: "https://attacker.example" },
          method: "POST",
        }),
      ),
    ).toThrow(ApiError);
    expect(() =>
      checkOrigin(
        new Request("https://app.example/api/chains", {
          headers: { origin: "https://app.example" },
          method: "POST",
        }),
      ),
    ).not.toThrow();
  });
  it("does not expose unhandled errors or credentials", async () => {
    const handler = route(async () => {
      throw new Error("secret-token-value");
    });
    const response = await handler(
      new Request("https://app.example/api/session"),
      { params: Promise.resolve({}) },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret-token-value");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("caps streamed body sizes even without content-length", async () => {
    const request = new Request("https://app.example/api/chains", {
      method: "POST",
      body: JSON.stringify({ name: "x".repeat(100) }),
    });
    await expect(readBody(request, chainSchema, 20)).rejects.toMatchObject({
      status: 413,
    });
  });
  it("validates malformed JSON and resource IDs", async () => {
    await expect(
      readBody(
        new Request("https://app.example", { method: "POST", body: "{" }),
        chainSchema,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(() => parseId("../admin")).toThrow(ApiError);
    expect(parseId("c41e8d9a-6714-491a-a68f-a324a3d39ebd")).toBeTruthy();
  });
});
