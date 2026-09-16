import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { PlanTracker } from "../tracker.mjs";
import { createPlanServer } from "../server.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "plan-time-machine-ui-"));
const tracker = new PlanTracker(root, { captureDelayMs: 600000, pollMs: 100, onError: () => {} });
let server;
let browser;
const first = "# Export plan\n\n## Access\nKeep regional access.\n\n## Delivery\nDownload immediately.\n";
const second = first.replace("Download immediately.", "Queue a background job.");
const third = second + "\n## Validation\nTest empty exports and retries.\n";
const artifactDir = process.env.PLAN_TEST_ARTIFACTS;

async function ready(page) {
    await page.locator('#document[aria-busy="false"]').waitFor();
}

async function textIncludes(page, selector, text) {
    await page.waitForFunction(([query, expected]) =>
        document.querySelector(query)?.textContent.includes(expected), [selector, text]);
}

async function screenshot(page, name) {
    if (!artifactDir) return;
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, name), fullPage: true });
}

try {
    await tracker.start();
    server = await createPlanServer(tracker, { onError: () => {} });
    const browserName = process.env.PLAN_TEST_BROWSER ?? "msedge";
    if (!["msedge", "chromium"].includes(browserName)) throw new Error("PLAN_TEST_BROWSER must be msedge or chromium.");
    browser = await chromium.launch({ ...(browserName === "msedge" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage({ viewport: { width: 420, height: 900 }, colorScheme: "light" });
    const pageErrors = [];
    const remoteRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (req) => {
        if (!req.url().startsWith(server.origin)) remoteRequests.push(req.url());
    });
    assert.equal((await page.goto(server.url)).status(), 200);
    await textIncludes(page, "#empty-message", "plan");
    assert.equal(await page.locator("#history").isVisible(), false);
    await screenshot(page, "waiting.png");

    await writeFile(tracker.planPath, first);
    const initial = await tracker.capture();
    await textIncludes(page, "#revision-title", "Initial plan");
    await ready(page);
    await page.locator('[data-view="plan"]').click();
    await textIncludes(page, "article.plan", "Download immediately.");

    const hostile = second + "\n## Preview safety\n" +
        "[Unsafe](javascript:alert(1))\n\n[Safe](https://example.com/docs)\n\n" +
        "<script>window.__planInjected = true</script>\n" +
        '<img src="https://example.invalid/tracker" onerror="window.__planInjected=true">\n' +
        '<iframe src="https://example.invalid/frame"></iframe>\n\n' +
        "![Remote image](https://example.invalid/image.png)\n";
    await writeFile(tracker.planPath, hostile);
    await tracker.refresh();
    await textIncludes(page, "#revision-title", "Working changes");
    await ready(page);
    await page.locator('[data-view="plan"]').click();
    await textIncludes(page, "article.plan", "Preview safety");
    assert.equal(await page.evaluate(() => window.__planInjected), undefined);
    assert.equal(await page.locator("article.plan img, article.plan iframe, article.plan script").count(), 0);
    assert.equal(await page.locator('article.plan [href^="javascript:"]').count(), 0);
    const safeLink = page.locator('article.plan a[href="https://example.com/docs"]');
    assert.equal(await safeLink.getAttribute("target"), "_blank");
    assert.match(await safeLink.getAttribute("rel"), /noopener/);
    assert.match(await safeLink.getAttribute("rel"), /noreferrer/);
    assert.deepEqual(remoteRequests, []);

    await page.locator('[data-view="diff"]').click();
    await page.locator(".change-line.add").first().waitFor();
    await page.locator("#capture").click();
    await page.waitForFunction(() => !document.querySelector("#revision-title")?.textContent.includes("Working changes"));
    const captured = await tracker.refresh();
    assert.notEqual(captured.head, initial.head);
    assert.equal(captured.working, false);
    assert.equal(await readFile(tracker.planPath, "utf8"), hostile);

    await page.locator("#history-trigger").click();
    await page.locator(`[data-revision="${initial.head}"]`).click();
    await textIncludes(page, "#revision-title", "Initial plan");
    await writeFile(tracker.planPath, third);
    const newest = await tracker.capture();
    await page.waitForTimeout(1600);
    assert.equal(await page.locator("#revision-title").textContent(), "Initial plan");
    await page.locator('[data-view="plan"]').click();
    await textIncludes(page, "article.plan", "Download immediately.");
    assert.doesNotMatch(await page.locator("article.plan").textContent(), /Test empty exports and retries/);
    await page.locator("#jump-latest").click();
    await textIncludes(page, "#revision-hash", newest.head.slice(0, 7));
    await page.locator('[data-view="diff"]').click();
    const surrounding = page.locator(".surrounding summary").first();
    if (await surrounding.count()) {
        await surrounding.click();
        await page.waitForTimeout(1500);
        assert.equal(await page.locator(".surrounding").first().getAttribute("open"), "");
    }

    for (const theme of ["light", "dark"]) {
        await page.locator("#theme-trigger").click();
        await page.locator(`[data-theme-option="${theme}"]`).click();
        assert.equal(await page.locator("html").getAttribute("data-resolved-theme"), theme);
        await screenshot(page, `${theme}.png`);
        for (const width of [320, 420, 600, 1100]) {
            await page.setViewportSize({ width, height: 900 });
            for (const view of ["diff", "plan"]) {
                await page.locator(`[data-view="${view}"]`).click();
                await ready(page);
                const bounds = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
                assert.ok(bounds[0] <= bounds[1], `${theme}/${view} overflows at ${width}px.`);
            }
        }
        await page.setViewportSize({ width: 420, height: 900 });
        await page.locator('[data-view="diff"]').click();
    }
    await page.reload();
    await ready(page);
    assert.equal(await page.locator("html").getAttribute("data-appearance"), "dark");
    await page.locator("#theme-trigger").click();
    await page.locator('[data-theme-option="system"]').click();
    await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "light"));
    await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === "light");
    await page.evaluate(() => document.documentElement.setAttribute("data-color-mode", "dark"));
    await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === "dark");
    await page.evaluate(() => document.documentElement.removeAttribute("data-color-mode"));
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.resolvedTheme === "dark");

    await rm(tracker.planPath);
    await tracker.refresh();
    await page.locator("#status-banner").waitFor();
    await screenshot(page, "missing.png");
    await writeFile(tracker.planPath, Buffer.from([0, 1, 2]));
    await tracker.refresh();
    await page.locator("#error-banner").waitFor();
    assert.ok(!await page.locator("#capture").isVisible() || await page.locator("#capture").isDisabled());
    await screenshot(page, "error.png");
    await writeFile(tracker.planPath, third);
    await tracker.refresh();
    await page.locator("#error-banner").waitFor({ state: "hidden" });
    await ready(page);

    for (let i = 0; i < 50; i++) await tracker.store.capture(`# Revision ${i}\n\nHistorical plan.\n`);
    await tracker.capture();
    await page.waitForTimeout(1500);
    await page.locator("#history-trigger").click();
    await page.locator(".load-older").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-revision]").length > 50);
    await page.locator(`[data-revision="${initial.head}"]`).click();
    await textIncludes(page, "#revision-title", "Initial plan");
    await page.locator('[data-view="plan"]').click();
    await textIncludes(page, "article.plan", "Download immediately.");
    assert.deepEqual(pageErrors, []);

    const unauthorized = await browser.newPage();
    await unauthorized.goto(server.origin);
    await unauthorized.locator("#error-banner").waitFor();
    assert.match(await unauthorized.locator("#error-message").textContent(), /token|authorized|reopen/i);
    await unauthorized.close();
    console.log("Passed real-server UI checks: waiting, captures, history pinning/pagination, exact snapshots, Markdown safety, responsive themes, missing/error recovery, and authorization.");
} finally {
    await browser?.close();
    await server?.close();
    await tracker.dispose();
    await rm(root, { recursive: true, force: true });
}
