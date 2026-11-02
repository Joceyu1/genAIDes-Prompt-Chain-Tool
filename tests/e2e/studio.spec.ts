import { test, expect, type Page } from "@playwright/test";
import type { PromptChain, ChainRun, ChainStep } from "../../lib/types";

const stamp = "2026-11-02T15:00:00.000Z";
const ids = {
  chain: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  first: "33333333-3333-4333-8333-333333333333",
  second: "44444444-4444-4444-8444-444444444444",
};
const step = (id: string, name: string, position: number): ChainStep => ({
  id,
  chain_id: ids.chain,
  name,
  prompt: position
    ? "Make five witty captions using {{previous}}."
    : "Describe the image with useful details.",
  kind: "text",
  model: "gpt-4.1-mini",
  position,
});
const fixtures = (): PromptChain[] => [
  {
    id: ids.chain,
    name: "From image to punchline",
    description: "Turn a photo into five scroll-stopping, funny captions.",
    status: "active",
    created_at: stamp,
    updated_at: stamp,
    steps: [
      step(ids.first, "Describe the image", 0),
      step(ids.second, "Write five captions", 1),
    ],
  },
  {
    id: ids.other,
    name: "A fresh campaign idea",
    description: "Find an unexpected angle for your next campaign.",
    status: "draft",
    created_at: stamp,
    updated_at: stamp,
    steps: [],
  },
];

type State = {
  authenticated: boolean;
  chains: PromptChain[];
  runs: ChainRun[];
  rejectLogin: boolean;
  requests: { method: string; path: string; body: unknown }[];
};
async function mockApi(page: Page, overrides: Partial<State> = {}) {
  const state: State = {
    authenticated: true,
    chains: fixtures(),
    runs: [],
    rejectLogin: false,
    requests: [],
    ...overrides,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON();
    state.requests.push({ method, path, body });
    const send = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (path === "/api/session")
      return state.authenticated
        ? send({ user: { id: ids.first, email: "jocelyn@genaides.com" } })
        : send({ error: "Sign in to continue." }, 401);
    if (path === "/api/auth/login") {
      if (state.rejectLogin)
        return send(
          { error: "This workspace is available to superadmins only." },
          403,
        );
      state.authenticated = true;
      return send({ ok: true });
    }
    if (path === "/api/auth/logout") {
      state.authenticated = false;
      return send({ ok: true });
    }
    if (!state.authenticated)
      return send({ error: "Sign in to continue." }, 401);
    if (path === "/api/chains") {
      if (method === "GET") return send({ chains: state.chains });
      const chain: PromptChain = {
        id: crypto.randomUUID(),
        created_at: stamp,
        updated_at: stamp,
        steps: [],
        ...body,
      };
      state.chains.push(chain);
      return send({ chain }, 201);
    }
    const match = path.match(/^\/api\/chains\/([^/]+)(?:\/(.*))?$/);
    if (!match) return send({ error: "Unknown endpoint" }, 404);
    const chain = state.chains.find((c) => c.id === match[1]);
    if (!chain) return send({ error: "Chain not found" }, 404);
    const suffix = match[2];
    if (!suffix) {
      if (method === "PATCH") {
        Object.assign(chain, body);
        return send({ chain });
      }
      if (method === "DELETE") {
        state.chains = state.chains.filter((c) => c.id !== chain.id);
        return send({ ok: true });
      }
    }
    if (suffix === "steps" && method === "POST") {
      const next: ChainStep = {
        id: crypto.randomUUID(),
        chain_id: chain.id,
        position: chain.steps.length,
        ...body,
      };
      chain.steps.push(next);
      return send({ step: next }, 201);
    }
    if (suffix === "steps/order") {
      chain.steps = body.stepIds.map((id: string, position: number) => ({
        ...chain.steps.find((s) => s.id === id),
        position,
      }));
      return send({ steps: chain.steps });
    }
    if (suffix?.startsWith("steps/")) {
      const stepId = suffix.split("/")[1];
      const selected = chain.steps.find((s) => s.id === stepId);
      if (method === "PATCH") {
        Object.assign(selected!, body);
        return send({ step: selected });
      }
      if (method === "DELETE") {
        chain.steps = chain.steps
          .filter((s) => s.id !== stepId)
          .map((s, position) => ({ ...s, position }));
        return send({ ok: true });
      }
    }
    if (suffix === "runs") {
      if (method === "GET")
        return send({
          runs: state.runs.filter((r) => r.chain_id === chain.id),
        });
      const run: ChainRun = {
        id: crypto.randomUUID(),
        chain_id: chain.id,
        input: body.input,
        status: "completed",
        error: null,
        created_at: stamp,
        outputs: chain.steps.map((s) => ({
          step_id: s.id,
          step_name: s.name,
          kind: s.kind,
          content:
            "1. A picture is worth a thousand punchlines.\n2. Main character energy, questionable decisions.",
        })),
      };
      state.runs.unshift(run);
      return send({ run }, 201);
    }
    return send({ error: "Unhandled endpoint" }, 400);
  });
  return state;
}
const openFirst = async (page: Page) => {
  await page
    .getByRole("button", { name: "Open From image to punchline", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "From image to punchline", exact: true }),
  ).toBeVisible();
};

test("anonymous visitors sign in and nonadmins stay outside the workspace", async ({
  page,
}) => {
  const state = await mockApi(page, {
    authenticated: false,
    rejectLogin: true,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome to your studio." }),
  ).toBeVisible();
  if (process.env.CAPTURE_UI)
    await page.screenshot({ path: "/tmp/chainlab-login.png", fullPage: true });
  await expect(
    page.getByRole("button", { name: "Create chain", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Email address").fill("member@genaides.com");
  await page.getByLabel("Password", { exact: true }).fill("example-password");
  await page.getByRole("button", { name: "Sign in to Chainlab" }).click();
  await expect(page.locator(".auth-error")).toHaveText(
    "This workspace is available to superadmins only.",
  );
  state.rejectLogin = false;
  await page.getByRole("button", { name: "Sign in to Chainlab" }).click();
  await expect(
    page.getByRole("heading", { name: "Prompt chains." }),
  ).toBeVisible();
});

test("chains can be created, edited, and permanently deleted", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Create chain", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chain name").fill("Product storytelling");
  await dialog
    .getByLabel("Description")
    .fill("Build a brand story from a product idea.");
  await dialog
    .getByRole("button", { name: "Create chain", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Product storytelling", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Chain settings" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Chain name").fill("Product storytelling v2");
  await dialog.getByLabel("Status").selectOption("active");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.getByRole("heading", { name: "Product storytelling v2", exact: true }),
  ).toBeVisible();
  expect(
    state.chains.find((c) => c.name === "Product storytelling v2")?.status,
  ).toBe("active");
  await page.getByRole("button", { name: "Delete this chain" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Prompt chains." }),
  ).toBeVisible();
  expect(state.chains.some((c) => c.name === "Product storytelling v2")).toBe(
    false,
  );
});

test("prompt steps support editing, keyboard reordering, image models, and deletion", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");
  await openFirst(page);
  await page
    .getByRole("button", { name: "Move Write five captions up" })
    .click();
  await expect(page.locator(".step-card h3").first()).toHaveText(
    "Write five captions",
  );
  expect(state.chains[0].steps.map((s) => s.id)).toEqual([
    ids.second,
    ids.first,
  ]);
  await page.locator(".step-card-body").first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Step name").fill("Write five brilliant captions");
  await dialog
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Write five concise captions: {{input}}");
  await dialog.getByRole("button", { name: "Save step" }).click();
  await expect(
    page.getByRole("heading", { name: "Write five brilliant captions" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add a step" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Step name").fill("Create the poster");
  await dialog.getByLabel("Output type").selectOption("image");
  await expect(dialog.getByLabel("Model")).toHaveValue("gpt-image-1");
  await dialog
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Create an editorial poster using {{previous}}");
  await dialog.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(page.locator(".step-card")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Delete Create the poster", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await expect(page.locator(".step-card")).toHaveCount(2);
  expect(state.chains[0].steps.map((s) => s.position)).toEqual([0, 1]);
});

test("dragging a step persists the new order", async ({ page }) => {
  const state = await mockApi(page);
  await page.goto("/");
  await openFirst(page);
  if (process.env.CAPTURE_UI)
    await page.screenshot({ path: "/tmp/chainlab-editor.png", fullPage: true });
  const cards = page.locator(".step-card");
  await cards.nth(1).dragTo(cards.nth(0));
  await expect(page.locator(".step-card h3").first()).toHaveText(
    "Write five captions",
  );
  expect(
    state.requests.some(
      (r) => r.method === "PUT" && r.path.endsWith("/steps/order"),
    ),
  ).toBe(true);
});

test("running a chain sends input, shows outputs, and exposes history in the media library", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");
  await openFirst(page);
  await page.getByRole("button", { name: "Run chain", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Your input")
    .fill("A very serious cat in a tiny hat");
  await dialog.getByRole("button", { name: "Run chain", exact: true }).click();
  await expect(page.locator(".run-card")).toHaveCount(1);
  await page.locator(".run-card-heading").click();
  await expect(page.locator(".run-output")).toHaveCount(2);
  await expect(page.locator(".run-output pre").first()).toContainText(
    "A picture is worth a thousand punchlines.",
  );
  expect(state.runs[0].input).toBe("A very serious cat in a tiny hat");
  await page
    .getByRole("button", { name: "Media library", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Media library." }),
  ).toBeVisible();
  await expect(page.locator(".run-card")).toHaveCount(1);
  await page.getByLabel("Filter media by prompt chain").selectOption(ids.other);
  await expect(page.locator(".run-card")).toHaveCount(0);
});

test("search, status filters, list view, and themes change the library", async ({
  page,
}) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator(".chain-card")).toHaveCount(2);
  if (process.env.CAPTURE_UI)
    await page.screenshot({
      path: "/tmp/chainlab-library.png",
      fullPage: true,
    });
  await page.getByLabel("Search chains").fill("campaign");
  await expect(page.locator(".chain-card")).toHaveCount(1);
  await expect(page.locator(".chain-card h3")).toHaveText(
    "A fresh campaign idea",
  );
  await page.getByRole("button", { name: "Clear search" }).click();
  await page
    .locator(".filter-tabs")
    .getByRole("button", { name: /^Active/ })
    .click();
  await expect(page.locator(".chain-card")).toHaveCount(1);
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await expect(page.locator(".chain-grid")).toHaveClass(/chain-list/);
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "System theme", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("mobile library and editor fit the viewport and navigation opens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/");
  await expect(page.locator(".chain-card")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/is-open/);
  await page.getByRole("button", { name: /^Prompt chains/ }).click();
  await openFirst(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Add a step" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("account signout returns to the private sign-in screen", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to your studio." }),
  ).toBeVisible();
  expect(state.authenticated).toBe(false);
});
