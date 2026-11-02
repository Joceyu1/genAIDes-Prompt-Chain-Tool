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
  route,
} from "../lib/server";
import { chainSchema } from "../lib/validation";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "public-test-key");
  mocks.create.mockReset();
});
describe("superadmin authorization", () => {
  it("denies an anonymous session", async () => {
    mocks.create.mockReturnValue({
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: null }, error: null }),
      },
    });
    await expect(requireAdmin()).rejects.toMatchObject({ status: 401 });
  });
  it.each([false, null, "true"])(
    "denies a non-boolean or missing admin flag (%s)",
    async (flag) => {
      const maybeSingle = vi.fn().mockResolvedValue({
        data: flag === null ? null : { is_superadmin: flag },
        error: null,
      });
      mocks.create.mockReturnValue({
        auth: {
          getUser: vi
            .fn()
            .mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
        },
        from: vi.fn(() => ({
          select: () => ({ eq: () => ({ maybeSingle }) }),
        })),
      });
      await expect(requireAdmin()).rejects.toMatchObject({ status: 403 });
    },
  );
  it("allows only a verified authenticated superadmin", async () => {
    const maybeSingle = vi
      .fn()
      .mockResolvedValue({ data: { is_superadmin: true }, error: null });
    const db = {
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
      },
      from: vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) })),
    };
    mocks.create.mockReturnValue(db);
    await expect(requireAdmin()).resolves.toMatchObject({
      user: { id: "user" },
    });
    expect(db.auth.getUser).toHaveBeenCalledOnce();
  });
  it("fails closed if profile verification fails", async () => {
    mocks.create.mockReturnValue({
      auth: {
        getUser: vi
          .fn()
          .mockResolvedValue({ data: { user: { id: "user" } }, error: null }),
      },
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: null,
              error: { code: "DB_DOWN" },
            }),
          }),
        }),
      })),
    });
    await expect(requireAdmin()).rejects.toMatchObject({ status: 503 });
  });
});
describe("request boundaries", () => {
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
