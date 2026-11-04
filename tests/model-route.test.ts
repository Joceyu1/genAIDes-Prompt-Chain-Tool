import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/server")>()),
  requireAdmin: mocks.auth,
}));

import { GET } from "../app/api/models/route";
import { ApiError } from "../lib/server";

const model = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "Studio model",
  model: "gpt-4.1-mini",
  provider: "openai",
  kind: "text",
  active: true,
};
const request = () => new Request("https://app.example/api/models");
const context = () => ({ params: Promise.resolve({}) });

beforeEach(() => {
  mocks.auth.mockReset();
});

describe("protected model choices endpoint", () => {
  it("returns only validated model-choice descriptors to an approved superadmin", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          ...model,
          api_key: "fixture-not-a-real-key",
          provider_configuration: { private: "fixture" },
        },
      ],
      error: null,
    });
    mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [model] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("chainlab_list_models");
  });

  it.each([401, 403])(
    "denies unapproved sessions before reading model choices (%i)",
    async (status) => {
      const rpc = vi.fn();
      mocks.auth.mockRejectedValue(new ApiError(status, "Access denied"));
      const response = await GET(request(), context());
      expect(response.status).toBe(status);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["PGRST202", 503],
    ["42501", 403],
  ])(
    "reports registry error %s instead of hiding it as an empty list",
    async (code, status) => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { code, message: "private registry metadata" },
      });
      mocks.auth.mockResolvedValue({ db: { rpc }, user: { id: "admin" } });
      const response = await GET(request(), context());
      const body = await response.json();
      expect(response.status).toBe(status);
      expect(body).not.toHaveProperty("models");
      expect(body.error).not.toContain("private registry metadata");
    },
  );
});
