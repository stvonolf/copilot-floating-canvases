import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PlanTracker } from "../tracker.mjs";
import { createPlanServer } from "../server.mjs";

const fixture = await mkdtemp(path.join(os.tmpdir(), "plan-popout-ui-"));
const tracker = new PlanTracker(fixture, { captureDelayMs: 600000, onError: () => {} });
let server, browser;
let failLaunch = false;
const windows = [];

async function eventually(check, timeout = 12000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("Window state did not settle.");
}

async function snapshot(page, name) {
    if (process.env.PLAN_TEST_ARTIFACTS) {
        await mkdir(process.env.PLAN_TEST_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PLAN_TEST_ARTIFACTS, name), fullPage: true });
    }
}

try {
    await tracker.start();
    const initialPlan = "# Export plan\n\n" + Array.from({ length: 140 }, (_, i) => `- Requirement ${i + 1}: preserve behavior.`).join("\n") + "\n";
    await writeFile(tracker.planPath, initialPlan);
    const initial = await tracker.capture();
    await writeFile(tracker.planPath, initialPlan + "\n## Delivery\nUse background jobs.\n");
    const second = await tracker.capture();
    const planBefore = await readFile(tracker.planPath);
    server = await createPlanServer(tracker, {
        onError: () => {},
        launchWindow: async (url) => {
            if (failLaunch) throw new Error("Simulated browser launch failure");
            let exit;
            const window = {
                url,
                closed: new Promise((resolve) => { exit = resolve; }),
                close: async () => {
                    exit({ code: 0 });
                    if (window.page && !window.page.isClosed()) await window.page.close();
                },
            };
            window.exit = exit;
            windows.push(window);
            return window;
        },
    });
    browser = await chromium.launch({ ...(process.env.PLAN_TEST_BROWSER === "chromium" ? {} : { channel: "msedge" }), headless: true });
    const context = await browser.newContext({ viewport: { width: 420, height: 800 }, colorScheme: "light" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url);
    await page.locator("#history-trigger").click();
    await page.locator(`[data-revision="${initial.head}"]`).click();
    await page.locator('[data-view="plan"]').click();
    await page.locator("article.plan").waitFor();
    await page.locator("#theme-trigger").click();
    await page.locator('[data-theme-option="dark"]').click();
    await page.evaluate(() => window.scrollTo(0, 450));
    await page.locator("#popout").click();
    await page.locator("#floating-notice").waitFor();
    assert.equal(windows.length, 1);
    assert.equal(server.floating.state().view.selectedId, initial.head);
    assert.equal(server.floating.state().view.view, "plan");
    assert.equal(server.floating.state().view.theme, "dark");
    assert.ok(server.floating.state().view.scrollY >= 400);
    assert.equal(await page.locator("#main-content").isVisible(), false);
    await snapshot(page, "floating-panel.png");

    const externalContext = await browser.newContext({ viewport: { width: 820, height: 900 }, colorScheme: "light" });
    const floating = await externalContext.newPage();
    windows[0].page = floating;
    floating.on("pageerror", (error) => errors.push(error.message));
    await floating.goto(windows[0].url);
    await floating.waitForFunction(() => document.querySelector("#revision-title")?.textContent === "Initial plan");
    await floating.locator("article.plan").waitFor();
    await eventually(() => server.floating.state().connected);
    assert.equal(await floating.locator("html").getAttribute("data-resolved-theme"), "dark");
    assert.equal(await floating.locator('[data-view="plan"]').getAttribute("aria-pressed"), "true");
    assert.equal(await floating.locator("#popin").isVisible(), true);
    assert.equal(await floating.locator("#popout").isVisible(), false);
    await eventually(async () => await floating.evaluate(() => scrollY) >= 400);
    await snapshot(floating, "floating-window.png");

    // A shared server does not require shared browser storage or localStorage.
    await writeFile(tracker.planPath, initialPlan + "\n## Delivery\nUse streaming background jobs.\n");
    await tracker.capture();
    await floating.waitForTimeout(1400);
    assert.equal(await floating.locator("#revision-title").textContent(), "Initial plan");
    await floating.locator("#history-trigger").click();
    await floating.locator(`[data-revision="${second.head}"]`).click();
    await floating.locator('[data-view="diff"]').click();
    await floating.locator(".change-line.add").first().waitFor();
    await floating.locator("#theme-trigger").click();
    await floating.locator('[data-theme-option="light"]').click();
    await eventually(() => server.floating.state().view.selectedId === second.head && server.floating.state().view.theme === "light");
    const closed = floating.waitForEvent("close");
    await floating.locator("#popin").click();
    await closed;
    await page.locator("#floating-notice").waitFor({ state: "hidden" });
    await page.waitForFunction((id) => document.querySelector("#revision-hash")?.textContent === id.slice(0, 7), second.head);
    assert.equal(await page.locator('[data-view="diff"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("html").getAttribute("data-resolved-theme"), "light");
    assert.equal(await page.evaluate(() => localStorage.getItem("plan-time-machine-theme")), "light");

    await page.locator("#popout").click();
    await page.locator("#floating-notice").waitFor();
    const natural = await externalContext.newPage();
    await natural.goto(windows[1].url);
    await eventually(() => server.floating.state().connected);
    windows[1].exit({ code: 0 });
    await natural.close();
    await page.locator("#floating-notice").waitFor({ state: "hidden" });
    assert.equal(server.floating.state().error, null);

    failLaunch = true;
    await page.locator("#popout").click();
    await page.locator("#window-error").waitFor();
    assert.match(await page.locator("#window-error").textContent(), /launch failure/);
    assert.equal(await page.locator("#main-content").isVisible(), true);
    failLaunch = false;
    await page.locator("#popout").click();
    await page.locator("#floating-notice").waitFor();
    const bringBack = await externalContext.newPage();
    await bringBack.goto(windows[2].url);
    await eventually(() => server.floating.state().connected);
    await page.locator("#bring-back").click();
    await page.locator("#floating-notice").waitFor({ state: "hidden" });
    await bringBack.locator("#floating-notice").waitFor();
    assert.match(await bringBack.locator("#floating-title").textContent(), /returned/);
    await bringBack.close();

    for (const width of [320, 420, 820]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await page.locator("#popout").isVisible(), true);
    }
    assert.deepEqual(errors, []);
    assert.equal((await tracker.list()).entries.length, 3);
    assert.ok((await readFile(tracker.planPath)).length > planBefore.length);
    assert.equal((await tracker.revision(initial.head)).content, initialPlan);
    console.log("Passed pop-out UI: isolated browser contexts, revision/view/theme/scroll transfer, return controls, natural close, failure recovery, shared history, and narrow layouts.");
} finally {
    await browser?.close();
    await server?.close();
    await tracker.dispose();
    await rm(fixture, { recursive: true, force: true });
}
