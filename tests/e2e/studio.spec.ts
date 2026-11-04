import { test, expect, type Page } from "@playwright/test";
import type { PromptChain, ChainRun, ChainStep } from "../../lib/types";
import type { RegistryModelDescriptor } from "../../lib/existing-schema";
import type { LegacyHistoryItem } from "../../lib/legacy-history";

const stamp = "2026-11-02T15:00:00.000Z";
const ids = {
  chain: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  first: "33333333-3333-4333-8333-333333333333",
  second: "44444444-4444-4444-8444-444444444444",
  textModel: "55555555-5555-4555-8555-555555555555",
  imageModel: "66666666-6666-4666-8666-666666666666",
  inactiveModel: "77777777-7777-4777-8777-777777777777",
  unknownModel: "88888888-8888-4888-8888-888888888888",
};
type RegistryFixture = RegistryModelDescriptor & { active?: boolean };
const registryFixtures = (): RegistryFixture[] => [
  {
    id: ids.textModel,
    label: "Studio text model",
    model: "gpt-4.1",
    provider: "openai",
    kind: "text",
    active: true,
  },
  {
    id: ids.imageModel,
    label: "Studio image model",
    model: "gpt-image-1",
    provider: "openai",
    kind: "image",
    active: true,
  },
  {
    id: ids.inactiveModel,
    label: "Retired text model",
    model: "gpt-4.1-mini",
    provider: "openai",
    kind: "text",
    active: false,
  },
];
const step = (id: string, name: string, position: number): ChainStep => ({
  id,
  chain_id: ids.chain,
  name,
  prompt:
    position > 1
      ? "Make five witty captions using {{previous}}."
      : "Describe the image with useful details.",
  kind: "text",
  model: "gpt-4.1-mini",
  role: position === 1 ? "system" : "user",
  model_id: null,
  model_label: "GPT-4.1 mini",
  generation_ready: true,
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
      step(ids.first, "Describe the image", 1),
      step(ids.second, "Write five captions", 2),
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
  legacy: LegacyHistoryItem[];
  rejectLogin: boolean;
  models: RegistryFixture[];
  modelsUnavailable: boolean;
  requests: { method: string; path: string; body: unknown }[];
};
async function mockApi(page: Page, overrides: Partial<State> = {}) {
  const state: State = {
    authenticated: true,
    chains: fixtures(),
    runs: [],
    legacy: [],
    rejectLogin: false,
    models: registryFixtures(),
    modelsUnavailable: false,
    requests: [],
    ...overrides,
  };
  const resolveStep = (value: ChainStep): ChainStep => {
    const supported =
      value.kind === "image"
        ? ["gpt-image-1"]
        : ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"];
    if (value.model_id) {
      const assigned = state.models.find(
        (model) => model.id === value.model_id,
      );
      return {
        ...value,
        model: assigned?.model || "",
        model_label: assigned?.label || "Assigned model",
        generation_ready: Boolean(
          assigned &&
          assigned.active !== false &&
          assigned.provider.toLowerCase() === "openai" &&
          supported.includes(assigned.model) &&
          (!assigned.kind || assigned.kind === value.kind),
        ),
      };
    }
    return {
      ...value,
      model_id: null,
      generation_ready: supported.includes(value.model),
    };
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
    if (path === "/api/models")
      return state.modelsUnavailable
        ? send({ error: "Model registry temporarily unavailable." }, 503)
        : send({ models: state.models });
    if (path === "/api/chains") {
      if (method === "GET")
        return send({
          chains: state.chains.map((chain) => ({
            ...chain,
            steps: chain.steps.map(resolveStep),
          })),
        });
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
      if (method === "GET")
        return send({
          chain: { ...chain, steps: chain.steps.map(resolveStep) },
        });
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
      const next: ChainStep = resolveStep({
        id: crypto.randomUUID(),
        chain_id: chain.id,
        position: chain.steps.length + 1,
        role: "user",
        model_id: null,
        ...body,
      });
      chain.steps.push(next);
      return send({ step: next }, 201);
    }
    if (suffix === "steps/order") {
      chain.steps = body.stepIds.map((id: string, position: number) => ({
        ...chain.steps.find((s) => s.id === id),
        position: position + 1,
      }));
      return send({ steps: chain.steps });
    }
    if (suffix?.startsWith("steps/")) {
      const stepId = suffix.split("/")[1];
      const selected = chain.steps.find((s) => s.id === stepId);
      if (method === "PATCH") {
        Object.assign(selected!, body);
        Object.assign(selected!, resolveStep(selected!));
        return send({ step: selected });
      }
      if (method === "DELETE") {
        chain.steps = chain.steps
          .filter((s) => s.id !== stepId)
          .map((s, position) => ({ ...s, position: position + 1 }));
        return send({ ok: true });
      }
    }
    if (suffix === "runs") {
      if (method === "GET")
        return send({
          runs: state.runs.filter((r) => r.chain_id === chain.id),
          legacy: state.legacy.filter((entry) => entry.chain_id === chain.id),
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
  await expect(dialog.getByLabel("Prompt role")).toHaveValue("user");
  await expect(dialog.getByLabel("Model assignment")).toHaveValue("");
  await dialog.getByLabel("Output type").selectOption("image");
  await expect(
    dialog.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveValue("gpt-image-1");
  await dialog
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Create an editorial poster using {{previous}}");
  await dialog.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(page.locator(".step-card")).toHaveCount(3);
  expect(state.chains[0].steps[2]).toMatchObject({
    role: "user",
    model_id: null,
    kind: "image",
    model: "gpt-image-1",
  });
  await page
    .getByRole("button", { name: "Delete Create the poster", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await expect(page.locator(".step-card")).toHaveCount(2);
  expect(state.chains[0].steps.map((s) => s.position)).toEqual([1, 2]);
});

test("an assigned registry model and prompt role survive editing until explicitly changed", async ({
  page,
}) => {
  const chains = fixtures();
  chains[0].steps[0] = {
    ...chains[0].steps[0],
    model_id: ids.textModel,
    prompt: "  Keep this template.\n",
  };
  const state = await mockApi(page, { chains });
  await page.goto("/");
  await openFirst(page);
  await expect(page.locator(".step-card").first()).toContainText(
    "Studio text model",
  );
  await page.locator(".step-card-body").first().click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Model assignment")).toHaveValue(
    ids.textModel,
  );
  await expect(dialog.getByLabel("Prompt role")).toHaveValue("system");
  await dialog.getByLabel("Step name").fill("Describe with care");
  await dialog.getByRole("button", { name: "Save step" }).click();
  await expect(
    page.getByRole("heading", { name: "Describe with care", exact: true }),
  ).toBeVisible();
  expect(
    state.requests.find(
      (request) =>
        request.method === "PATCH" &&
        request.path.endsWith(`/steps/${ids.first}`),
    )?.body,
  ).toMatchObject({
    role: "system",
    model_id: ids.textModel,
    model: "gpt-4.1",
  });
  expect(state.chains[0].steps[0]).toMatchObject({
    role: "system",
    model_id: ids.textModel,
    prompt: "  Keep this template.\n",
  });
  await page.locator(".step-card-body").first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Prompt role").selectOption("assistant");
  await dialog.getByRole("button", { name: "Save step" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.chains[0].steps[0]).toMatchObject({
    role: "assistant",
    model_id: ids.textModel,
  });
  await page.locator(".step-card-body").first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Model assignment").selectOption("");
  await dialog
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption("gpt-4o-mini");
  await dialog.getByRole("button", { name: "Save step" }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.chains[0].steps[0]).toMatchObject({
    role: "assistant",
    model_id: null,
    model: "gpt-4o-mini",
  });
});

test("an unknown assigned model remains editable when the registry cannot load", async ({
  page,
}) => {
  const chains = fixtures();
  chains[0].steps[0] = {
    ...chains[0].steps[0],
    model_id: ids.unknownModel,
    model: "",
    model_label: "Assigned model",
    generation_ready: false,
  };
  const state = await mockApi(page, { chains, modelsUnavailable: true });
  await page.goto("/");
  await openFirst(page);
  await expect(
    page.getByRole("button", { name: "Run chain", exact: true }),
  ).toBeDisabled();
  await page.locator(".step-card-body").first().click();
  const dialog = page.getByRole("dialog");
  const assignment = dialog.getByLabel("Model assignment");
  await expect(assignment).toHaveValue(ids.unknownModel);
  await expect(
    assignment.locator(`option[value="${ids.unknownModel}"]`),
  ).toContainText("Assigned model");
  await expect(dialog.getByText(/Model choices could not load/)).toBeVisible();
  await dialog.getByLabel("Step name").fill("Keep this assignment");
  await dialog
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Describe the image without changing its assigned model.");
  await dialog.getByRole("button", { name: "Save step" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep this assignment", exact: true }),
  ).toBeVisible();
  expect(state.chains[0].steps[0]).toMatchObject({
    model_id: ids.unknownModel,
    role: "system",
    model: "",
    generation_ready: false,
  });
  expect(
    state.requests.find(
      (request) =>
        request.method === "PATCH" &&
        request.path.endsWith(`/steps/${ids.first}`),
    )?.body,
  ).toMatchObject({ model_id: ids.unknownModel, model: "", role: "system" });
});

test("choosing an image registry assignment updates output type and preserves its UUID", async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.goto("/");
  await openFirst(page);
  await page.getByRole("button", { name: "Add a step" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Step name").fill("Assigned image step");
  await dialog.getByLabel("Model assignment").selectOption(ids.imageModel);
  await expect(dialog.getByLabel("Output type")).toHaveValue("image");
  await expect(dialog.getByLabel("Prompt role")).toHaveValue("user");
  await dialog
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Create a friendly poster from {{previous}}.");
  await dialog.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(page.locator(".step-card")).toHaveCount(3);
  expect(state.chains[0].steps[2]).toMatchObject({
    role: "user",
    model_id: ids.imageModel,
    model: "gpt-image-1",
    kind: "image",
    generation_ready: true,
  });
});

test("inactive model assignments stay editable while generation and new assignments are blocked", async ({
  page,
}) => {
  const chains = fixtures();
  chains[0].steps[0] = { ...chains[0].steps[0], model_id: ids.inactiveModel };
  const state = await mockApi(page, { chains });
  await page.goto("/");
  await openFirst(page);
  await expect(
    page.getByRole("button", { name: "Run chain", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".step-card").first()).toContainText(
    "Retired text model",
  );
  await page.locator(".step-card-body").first().click();
  let dialog = page.getByRole("dialog");
  const current = dialog.getByLabel("Model assignment");
  await expect(current).toHaveValue(ids.inactiveModel);
  await expect(
    current.locator(`option[value="${ids.inactiveModel}"]`),
  ).toHaveJSProperty("disabled", false);
  await dialog.getByLabel("Step name").fill("Preserve retired assignment");
  await dialog.getByRole("button", { name: "Save step" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Preserve retired assignment",
      exact: true,
    }),
  ).toBeVisible();
  expect(state.chains[0].steps[0]).toMatchObject({
    model_id: ids.inactiveModel,
    generation_ready: false,
  });
  await page.getByRole("button", { name: "Add a step" }).click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog
      .getByLabel("Model assignment")
      .locator(`option[value="${ids.inactiveModel}"]`),
  ).toHaveJSProperty("disabled", true);
});

test("chains can grow beyond ten steps while generation keeps its separate run limit", async ({
  page,
}) => {
  const chains = fixtures();
  chains[0].steps = Array.from({ length: 10 }, (_, index) =>
    step(
      `99999999-9999-4999-8999-${String(index + 1).padStart(12, "0")}`,
      `Existing step ${index + 1}`,
      index + 1,
    ),
  );
  const state = await mockApi(page, { chains });
  await page.goto("/");
  await openFirst(page);
  const add = page.getByRole("button", { name: "Add a step" });
  await expect(add).toBeEnabled();
  await add.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Step name").fill("Step eleven");
  await dialog
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Continue from {{previous}}.");
  await dialog.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(page.locator(".step-card")).toHaveCount(11);
  await expect(page.getByRole("button", { name: "Add a step" })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Run chain", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/10 steps/).first()).toBeVisible();
  expect(state.chains[0].steps.at(-1)?.position).toBe(11);
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

test("saved history is read-only literal text and follows the selected chain", async ({
  page,
}) => {
  const savedOutput =
    '<img src=x onerror="window.legacyXss=true"> https://example.test/saved.png';
  const savedExample: LegacyHistoryItem = {
    source: "saved_example",
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    chain_id: ids.chain,
    created_at: stamp,
    prompt: "A saved example prompt",
    status: "legacy_example_ready",
    output: savedOutput,
    title: null,
    caption: null,
    model: "Old text model",
    origin: "assignment_snapshot",
    generation_prompt: null,
    generation_status: null,
    truncated: true,
  };
  const request: LegacyHistoryItem = {
    source: "generation_request",
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    chain_id: ids.chain,
    created_at: stamp,
    prompt: "The original saved request prompt",
    status: "queued_by_old_app",
    output: null,
    title: "A saved generation request",
    caption: "A caption from the older workflow",
    model: null,
    origin: null,
    generation_prompt: "Draw a tiny cat wearing a serious hat.",
    generation_status: "still_waiting_elsewhere",
    truncated: false,
  };
  const otherExample: LegacyHistoryItem = {
    ...savedExample,
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    chain_id: ids.other,
    prompt: "Only the other chain's saved prompt",
    output: "ONLY OTHER CHAIN SAVED OUTPUT",
    truncated: false,
  };
  await mockApi(page, { legacy: [savedExample, request, otherExample] });
  await page.goto("/");
  await openFirst(page);
  await page
    .getByRole("button", { name: "Generated media", exact: true })
    .click();
  const history = page.locator(".saved-history");
  await expect(
    history.getByRole("heading", { name: "Saved history", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".run-card")).toHaveCount(0);
  await expect(history.locator(".saved-history-card")).toHaveCount(2);
  await expect(history).toContainText("Saved example");
  await expect(history).toContainText("Generation request");
  for (const savedText of [
    savedOutput,
    "The original saved request prompt",
    "A caption from the older workflow",
    "Draw a tiny cat wearing a serious hat.",
  ])
    await expect(
      history.locator(".saved-history-text").filter({ hasText: savedText }),
    ).toBeVisible();
  await expect(history).toContainText("A saved generation request");
  await expect(history).toContainText("queued_by_old_app");
  await expect(history).toContainText("still_waiting_elsewhere");
  await expect(history).toContainText("Some saved text is shortened.");
  await expect(history.locator("button, a, img, .spin")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "legacyXss")),
  ).toBeUndefined();
  await expect(history).not.toContainText("ONLY OTHER CHAIN SAVED OUTPUT");
  await page
    .getByRole("button", { name: "Media library", exact: true })
    .click();
  await expect(history.locator(".saved-history-card")).toHaveCount(2);
  await page.getByLabel("Filter media by prompt chain").selectOption(ids.other);
  await expect(history.locator(".saved-history-card")).toHaveCount(1);
  await expect(history).toContainText("ONLY OTHER CHAIN SAVED OUTPUT");
  await expect(history).not.toContainText(savedOutput);
  await expect(history).not.toContainText("A saved generation request");
});

test("the example starter chooses the first unused loaded-chain name", async ({
  page,
}) => {
  const chains = fixtures();
  chains.push({
    ...chains[1],
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    name: "From image to punchline (2)",
    steps: [],
  });
  const state = await mockApi(page, { chains });
  await page.goto("/");
  await expect(page.locator(".chain-card")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Try this chain", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "From image to punchline (3)",
      exact: true,
    }),
  ).toBeVisible();
  const created = state.chains.find(
    (chain) => chain.name === "From image to punchline (3)",
  );
  expect(created?.steps).toHaveLength(3);
  expect(
    state.chains.filter((chain) => chain.name === "From image to punchline"),
  ).toHaveLength(1);
  expect(
    state.chains.filter(
      (chain) => chain.name === "From image to punchline (2)",
    ),
  ).toHaveLength(1);
  expect(
    state.requests.find(
      (request) => request.method === "POST" && request.path === "/api/chains",
    )?.body,
  ).toMatchObject({ name: "From image to punchline (3)" });
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

test("Google sign-in starts without requiring a password", async ({ page }) => {
  await mockApi(page, { authenticated: false });
  await page.route("**/api/auth/google", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://example.supabase.co/auth/v1/authorize?provider=google",
      }),
    }),
  );
  await page.route("https://example.supabase.co/auth/v1/authorize**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>Google authorization handoff</h1>",
    }),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue with Google", exact: true })
    .click();
  await expect(page).toHaveURL(/example.supabase.co\/auth\/v1\/authorize/);
});

test("OAuth failures are actionable and never expose callback codes", async ({
  page,
}) => {
  await mockApi(page, { authenticated: false });
  await page.goto("/?auth_error=profile_unavailable");
  await expect(page.locator(".auth-error")).toContainText(
    "administrator check could not run",
  );
  await expect(page).toHaveURL("http://localhost:3000/");
  await expect(
    page.getByRole("button", { name: "Continue with Google", exact: true }),
  ).toBeVisible();
});
