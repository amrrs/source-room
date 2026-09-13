import { test, expect } from "@playwright/test";

test("local setup state, desktop and responsive layouts", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your sources. A clearer answer." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send question", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Advanced controls", exact: true })
    .click();
  await expect(
    page.getByLabel("Allowed domains", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Allowed domains", { exact: false })
    .fill("nebius.com, arxiv.org");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Advanced controls", exact: true })
    .click();
  await expect(
    page.getByLabel("Allowed domains", { exact: false }),
  ).toHaveValue("nebius.com, arxiv.org");
  await page
    .getByRole("button", { name: "Reset defaults", exact: true })
    .click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("button", { name: "Upload a PDF" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Advanced controls", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.getByRole("button", { name: "Close Advanced controls" }).click();
    await page.screenshot({
      path: `test-results/workspace-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});

test("upload, source selection, streamed citations, evidence, clear chat, and errors", async ({
  page,
  request,
}) => {
  const config = await (await request.get("/api/config")).json();
  const source = {
    id: "test-pdf",
    name: "solar.pdf",
    kind: "pdf",
    url: "",
    model: config.defaults.embedding_model,
    chunks: 1,
    pages: 1,
  };
  let sources: unknown[] = [];
  let lastChat: any;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/config")
      return route.fulfill({
        json: {
          ...config,
          nebius_configured: true,
          tavily_configured: true,
          auth_required: false,
        },
      });
    if (path === "/api/workspace")
      return route.fulfill({ json: { sources, messages: [] } });
    if (path === "/api/sources/pdf") {
      sources = [source];
      return route.fulfill({ json: source });
    }
    if (path === "/api/chat") {
      lastChat = route.request().postDataJSON();
      return route.fulfill({
        contentType: "application/x-ndjson",
        body:
          [
            { type: "status", message: "Finding evidence…" },
            {
              type: "sources",
              sources: [
                {
                  id: 1,
                  title: "solar.pdf",
                  kind: "pdf",
                  page: 1,
                  url: "",
                  text: "Solar energy comes from sunlight.",
                },
              ],
              warnings: [],
            },
            { type: "token", text: "Solar energy comes from sunlight. [1]" },
            { type: "done", warnings: [] },
          ]
            .map(JSON.stringify)
            .join("\n") + "\n",
      });
    }
    if (path === "/api/sources/website")
      return route.fulfill({
        status: 422,
        json: { detail: "Tavily could not extract this page." },
      });
    if (path === "/api/messages") return route.fulfill({ json: { ok: true } });
    if (path === "/api/sources/test-pdf") {
      sources = [];
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Upload a PDF" }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "solar.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-test"),
  });
  await expect(page.getByText("solar.pdf", { exact: true })).toBeVisible();
  await page
    .getByRole("switch", { name: "Search the web", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Advanced controls", exact: true })
    .click();
  await page
    .getByLabel("Allowed domains", { exact: false })
    .fill("example.com");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ask a question" })
    .fill("Explain solar energy");
  await page
    .getByRole("button", { name: "Send question", exact: true })
    .click();
  await expect(
    page.getByText("Solar energy comes from sunlight. [1]", { exact: true }),
  ).toBeVisible();
  expect(lastChat.source_ids).toEqual(["test-pdf"]);
  expect(lastChat.settings.include_domains).toEqual(["example.com"]);
  expect(lastChat.settings.web_search).toBe(false);
  await page.getByRole("button", { name: /solar.pdf · p. 1/ }).click();
  await expect(
    page.getByRole("heading", { name: "Source evidence" }),
  ).toBeVisible();
  await expect(
    page.getByText("Solar energy comes from sunlight.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Source evidence" }).click();
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your sources. A clearer answer." }),
  ).toBeVisible();
  await expect(page.getByText("solar.pdf", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add a website" }).click();
  await page
    .getByLabel("Website URL", { exact: false })
    .fill("https://example.com");
  await page.getByRole("button", { name: "Add website", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Tavily could not extract this page.",
  );
});
