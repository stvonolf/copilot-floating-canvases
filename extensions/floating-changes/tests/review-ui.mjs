import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { ensureServer, registerWorkspace, retainWorkspace, releaseWorkspace, reviewStore } from "../server.mjs";

const exec = promisify(execFile);
const temp = await mkdtemp(path.join(os.tmpdir(), "since-looked-ui-"));
const root = path.join(temp, "repo");
const session = path.join(temp, "session");
let browser, server, workspace;
const file = (name) => path.join(root, name);
const git = async (...args) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout;
async function hasText(page, selector, expected) {
    await page.waitForFunction(([target, text]) => document.querySelector(target)?.textContent.includes(text), [selector, expected]);
}
async function enabled(page, id) {
    await page.waitForFunction((selector) => { const el = document.querySelector(selector); return el && !el.disabled; }, id);
}
async function artifact(page, name) {
    if (!process.env.REVIEW_TEST_ARTIFACTS) return;
    await mkdir(process.env.REVIEW_TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.REVIEW_TEST_ARTIFACTS, name), fullPage: true });
}
try {
    await mkdir(root);
    await mkdir(session);
    await git("init", "--template=", "-b", "main");
    await git("config", "user.email", "review@example.test");
    await git("config", "user.name", "Review UI");
    await git("config", "core.autocrlf", "false");
    await writeFile(file("a.txt"), "base\n");
    await writeFile(file("b.txt"), "original\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await writeFile(file("a.txt"), "base\nalready reviewed\n");
    workspace = await registerWorkspace(root, { sessionWorkspace: session });
    retainWorkspace(workspace);
    server = await ensureServer();
    const engine = process.env.REVIEW_TEST_BROWSER ?? "msedge";
    if (!["msedge", "chromium"].includes(engine)) throw new Error("Unsupported REVIEW_TEST_BROWSER.");
    browser = await chromium.launch({ ...(engine === "msedge" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    const url = `${server.origin}/?w=${workspace.token}&mode=panel`;
    await page.goto(url);
    await page.locator('button[data-path="a.txt"][data-kind="working"]').waitFor();
    await page.locator("#review-mode").click();
    await enabled(page, "#mark-reviewed");
    const review = await reviewStore(workspace);
    assert.equal((await review.metadata()).checkpoint, null);
    await artifact(page, "start.png");
    await page.locator("#mark-reviewed").click();
    await enabled(page, "#mark-reviewed");
    assert.ok((await review.metadata()).checkpoint);
    await writeFile(file("a.txt"), "base\nalready reviewed\nsince last review\n");
    await page.locator('.review-file[data-path="a.txt"]').waitFor();
    await page.locator('.review-file[data-path="a.txt"]').click();
    await hasText(page, "#diff", "+since last review");
    assert.doesNotMatch(await page.locator("#diff").textContent(), /^\+already reviewed$/m);
    await page.locator("#feedback-text").fill("<script>window.injected=true</script> Please check this.");
    await page.locator("#feedback-submit").click();
    await page.locator("[data-feedback-id]").first().waitFor();
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.getByText("<script>window.injected=true</script> Please check this.", { exact: true }).waitFor();
    assert.equal((await review.metadata()).feedback[0].status, "open");
    await enabled(page, "#mark-reviewed");
    await artifact(page, "delta-feedback.png");

    const oldCheckpoint = (await review.metadata()).checkpoint.id;
    await page.route("**/api/review/checkpoint?*", async (route) => {
        await writeFile(file("a.txt"), "base\nalready reviewed\nsince last review\nunseen edit\n");
        await route.continue();
    });
    const rejected = page.waitForResponse((response) => response.url().includes("/api/review/checkpoint") && response.status() === 409);
    await page.locator("#mark-reviewed").click();
    await rejected;
    assert.equal((await review.metadata()).checkpoint.id, oldCheckpoint);
    await page.locator("#review-message").waitFor();
    assert.match(await page.locator("#review-message").textContent(), /refresh/i);
    await page.unroute("**/api/review/checkpoint?*");
    await page.locator("#refresh").click();
    await hasText(page, "#diff", "+unseen edit");
    await enabled(page, "#mark-reviewed");
    await page.locator("#mark-reviewed").click();
    await enabled(page, "#mark-reviewed");
    assert.equal((await review.state()).files.length, 0);
    assert.equal((await review.metadata()).feedback[0].status, "open");
    await page.locator("#feedback-all").click();
    await page.locator("[data-feedback-id]").first().waitFor();
    await page.getByRole("button", { name: "Resolve", exact: true }).click();
    await page.getByRole("button", { name: "Reopen", exact: true }).waitFor();
    assert.equal((await review.metadata()).feedback[0].status, "resolved");
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await page.getByRole("button", { name: "Resolve", exact: true }).waitFor();

    await writeFile(file("b.txt"), "changed previously clean file\n");
    await page.locator('.review-file[data-path="b.txt"]').waitFor();
    await page.locator('.review-file[data-path="b.txt"]').click();
    await hasText(page, "#diff", "+changed previously clean file");
    await page.locator("#feedback-file").click();
    await page.locator("#feedback-text").fill("Unsubmitted draft");
    await page.waitForTimeout(3500);
    assert.equal(await page.locator("#feedback-text").inputValue(), "Unsubmitted draft");

    for (const width of [320, 420, 650, 1100]) {
        await page.setViewportSize({ width, height: 900 });
        const bounds = await page.evaluate(() => ({
            width: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            documentHeight: document.documentElement.scrollHeight,
            viewportHeight: innerHeight,
        }));
        assert.ok(bounds.scrollWidth <= bounds.width, `Horizontal overflow at ${width}px: ${JSON.stringify(bounds)}`);
        const mark = await page.locator("#mark-reviewed").boundingBox();
        assert.ok(mark && mark.x >= 0 && mark.x + mark.width <= width, "Review button is outside the side panel.");
    }
    await page.setViewportSize({ width: 420, height: 900 });
    await artifact(page, "narrow.png");
    await page.evaluate(() => {
        document.documentElement.style.setProperty("--background-color-default", "#ffffff");
        document.documentElement.style.setProperty("--text-color-default", "#1f2328");
        document.documentElement.style.setProperty("--text-color-muted", "#59636e");
        document.documentElement.style.setProperty("--border-color-default", "#d1d9e0");
    });
    await artifact(page, "light.png");
    await page.reload();
    await page.locator('button[data-path="a.txt"][data-kind="working"]').waitFor();
    await page.locator("#review-mode").click();
    await page.locator('.review-file[data-path="b.txt"]').waitFor();
    await page.locator("#feedback-all").click();
    await page.getByRole("button", { name: "Resolve", exact: true }).waitFor();
    assert.equal((await review.metadata()).feedback.length, 1);
    const popup = await browser.newPage();
    await popup.goto(`${server.origin}/?w=${workspace.token}&mode=detached&view=review`);
    await popup.locator('.review-file[data-path="b.txt"]').waitFor();
    await popup.locator("#feedback-all").click();
    await popup.getByRole("button", { name: "Resolve", exact: true }).click();
    await page.getByRole("button", { name: "Reopen", exact: true }).waitFor();
    await popup.close();
    let detachView = null;
    await page.route("**/api/detach?*", async (route) => {
        detachView = new URL(route.request().url()).searchParams.get("view");
        await route.fulfill({ status: 200, contentType: "application/json", body: '{"alreadyDetached":true}' });
    });
    const detaching = page.waitForResponse((response) => response.url().includes("/api/detach"));
    await page.locator("#popout").click();
    await detaching;
    assert.equal(detachView, "review");
    assert.deepEqual(errors, []);
    assert.equal(await readFile(file("b.txt"), "utf8"), "changed previously clean file\n");
    console.log("Passed real review UI: explicit baseline, exact delta, stale-view guard, safe feedback, persistence, panel sharing, and narrow layouts.");
} finally {
    await browser?.close();
    if (workspace) releaseWorkspace(workspace);
    await server?.close();
    await rm(temp, { recursive: true, force: true });
}
