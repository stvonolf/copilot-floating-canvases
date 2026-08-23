import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

import { parseNumstat, parsePorcelain, readChanges, readDiff } from "../git.mjs";
import {
    attachWorkspace,
    ensureServer,
    registerWorkspace,
    releaseWorkspace,
    retainWorkspace,
} from "../server.mjs";

const exec = promisify(execFile);
let passed = 0;
const failures = [];

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        passed++;
        console.log(`  PASS  ${label}`);
    } else {
        failures.push(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
        console.log(`  FAIL  ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
}

async function git(cwd, ...args) {
    try {
        return (await exec("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout;
    } catch (error) {
        if (args[0] === "merge" && error.code === 1) return error.stdout ?? "";
        throw error;
    }
}

async function makeFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "floating-changes-"));
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "changes@example.test");
    await git(root, "config", "user.name", "Changes Test");

    const files = {
        "working.txt": "base\n",
        "staged.txt": "base\n",
        "both.txt": "base\n",
        "rename-old.txt": "rename\n",
        "delete.txt": "delete\n",
        "conflict.txt": "base\n",
        "long.txt": Array.from({ length: 300 }, (_, index) => `base line ${index}`).join("\n") + "\n",
    };
    for (const [name, contents] of Object.entries(files)) await writeFile(path.join(root, name), contents);
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");

    await git(root, "switch", "-c", "conflict-other");
    await writeFile(path.join(root, "conflict.txt"), "other\n");
    await git(root, "add", "conflict.txt");
    await git(root, "commit", "-m", "other conflict");

    await git(root, "switch", "main");
    await writeFile(path.join(root, "conflict.txt"), "main\n");
    await git(root, "add", "conflict.txt");
    await git(root, "commit", "-m", "main conflict");
    await git(root, "merge", "conflict-other");

    await writeFile(path.join(root, "working.txt"), "base\nworking\n");
    await writeFile(path.join(root, "staged.txt"), "base\nstaged\n");
    await git(root, "add", "staged.txt");
    await writeFile(path.join(root, "both.txt"), "base\nstaged\n");
    await git(root, "add", "both.txt");
    await writeFile(path.join(root, "both.txt"), "base\nstaged\nworking\n");
    await writeFile(path.join(root, "untracked.txt"), "untracked\nline two\n");
    await writeFile(path.join(root, "long.txt"), Array.from({ length: 300 }, (_, index) => `changed line ${index}`).join("\n") + "\n");
    await git(root, "mv", "rename-old.txt", "renamed.txt");
    await rm(path.join(root, "delete.txt"));
    return root;
}

async function makeCleanFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "floating-changes-clean-"));
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "changes@example.test");
    await git(root, "config", "user.name", "Changes Test");
    await writeFile(path.join(root, "clean.txt"), "clean\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "clean");
    return root;
}

async function removeFixture(root) {
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            await rm(root, { recursive: true, force: true });
            return;
        } catch (error) {
            if (error.code !== "EBUSY" || attempt === 7) throw error;
            await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
}

async function openCanvas(browser, origin, token, mode = "panel") {
    const page = await browser.newPage({ viewport: { width: 1120, height: 720 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.__errors = errors;
    await page.goto(`${origin}/?w=${encodeURIComponent(token)}&mode=${mode}`);
    return page;
}

async function main() {
    const root = await makeFixture();
    const cleanRoot = await makeCleanFixture();
    const browser = await chromium.launch();
    let workspace = null;
    let cleanWorkspace = null;

    try {
        console.log("\n=== parser ===");
        const parsed = parsePorcelain("M  staged.txt\0 M working.txt\0?? untracked.txt\0UU conflict.txt\0");
        check("porcelain staged", parsed.staged.map((entry) => entry.path), ["staged.txt"]);
        check("porcelain working", parsed.working.map((entry) => entry.path), ["working.txt"]);
        check("porcelain untracked", parsed.untracked.map((entry) => entry.path), ["untracked.txt"]);
        check("porcelain conflict", parsed.conflicts.map((entry) => entry.path), ["conflict.txt"]);
        const numstat = parseNumstat("2\t1\tfile.txt\0-\t-\tbinary.dat\0");
        check("numstat text", numstat.get("file.txt"), { additions: 2, deletions: 1 });
        check("numstat binary", numstat.get("binary.dat"), { additions: null, deletions: null });

        console.log("\n=== data layer ===");
        const state = await readChanges(root);
        check("branch", state.branch, "main");
        check("conflict group", state.groups.conflicts.map((entry) => entry.path), ["conflict.txt"]);
        check("staged contains staged file", state.groups.staged.some((entry) => entry.path === "staged.txt"), true);
        check("staged contains rename", state.groups.staged.some((entry) => entry.path === "renamed.txt"), true);
        check("working contains modified file", state.groups.working.some((entry) => entry.path === "working.txt"), true);
        check("working contains deletion", state.groups.working.some((entry) => entry.path === "delete.txt"), true);
        check("file can be staged and working", [
            state.groups.staged.some((entry) => entry.path === "both.txt"),
            state.groups.working.some((entry) => entry.path === "both.txt"),
        ], [true, true]);
        check("untracked group", state.groups.untracked.map((entry) => entry.path), ["untracked.txt"]);
        check("working stats", state.groups.working.find((entry) => entry.path === "working.txt").additions, 1);

        const workingDiff = await readDiff(root, "working.txt", "working");
        check("working diff", workingDiff.diff.includes("+working"), true);
        const stagedDiff = await readDiff(root, "staged.txt", "staged");
        check("staged diff", stagedDiff.diff.includes("+staged"), true);
        const untrackedDiff = await readDiff(root, "untracked.txt", "untracked");
        check("untracked diff", untrackedDiff.diff.includes("+untracked"), true);
        let traversalRejected = false;
        try {
            await readDiff(root, "../outside.txt", "working");
        } catch (error) {
            traversalRejected = error.code === "path_outside_repository";
        }
        check("path traversal rejected", traversalRejected, true);

        console.log("\n=== UI ===");
        workspace = await registerWorkspace(root);
        cleanWorkspace = await registerWorkspace(cleanRoot);
        retainWorkspace(workspace);
        retainWorkspace(cleanWorkspace);
        const { origin } = await ensureServer();
        const page = await openCanvas(browser, origin, workspace.token);
        await page.waitForSelector('button[data-path="working.txt"][data-kind="working"]');

        check("repository shown", await page.locator("#repository").textContent(), path.basename(root));
        check("branch shown", await page.locator("#branch").textContent(), "main");
        check("conflicts rendered", await page.getByText("Conflicts", { exact: true }).count(), 1);
        check("staged rendered", await page.getByText("Staged changes", { exact: true }).count(), 1);
        check("working rendered", await page.getByText("Changes", { exact: true }).count(), 1);
        check("untracked rendered", await page.getByText("Untracked files", { exact: true }).count(), 1);

        await page.locator('button[data-path="working.txt"][data-kind="working"]').click();
        await page.waitForFunction(() => document.querySelector("#diff")?.textContent?.includes("+working"));
        check("working diff rendered", (await page.locator("#diff").textContent()).includes("+working"), true);

        await page.locator('button[data-path="both.txt"][data-kind="working"]').click();
        await page.waitForSelector(".diff-tab");
        check("both views available", await page.locator(".diff-tab").allTextContents(), ["Staged", "Working tree"]);
        await page.getByRole("button", { name: "Staged", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#diff")?.textContent?.includes("+staged"));
        check("staged tab switches diff", (await page.locator("#diff").textContent()).includes("+staged"), true);

        await page.locator('button[data-path="untracked.txt"][data-kind="untracked"]').click();
        await page.waitForFunction(() => document.querySelector("#diff")?.textContent?.includes("+untracked"));
        check("untracked diff rendered", (await page.locator("#diff").textContent()).includes("+untracked"), true);

        await page.locator("#filter").fill("working.txt");
        check("filter shows matching file", await page.locator('button[data-path="working.txt"]').count(), 1);
        check("filter hides untracked", await page.locator('button[data-path="untracked.txt"]').count(), 0);
        await page.locator("#filter").fill("");

        await page.locator('button[data-path="long.txt"][data-kind="working"]').click();
        await page.waitForFunction(() => document.querySelectorAll("#diff .diff-line").length > 500);
        await page.locator("#diff").evaluate((element) => {
            element.scrollTop = 700;
        });
        const scrollBefore = await page.locator("#diff").evaluate((element) => element.scrollTop);
        await new Promise((resolve) => setTimeout(resolve, 3200));
        const scrollAfter = await page.locator("#diff").evaluate((element) => element.scrollTop);
        check("background refresh preserves diff scroll", scrollAfter, scrollBefore);
        check("background refresh does not flash loading", (await page.locator("#diff").textContent()).includes("Loading diff"), false);

        await writeFile(
            path.join(root, "long.txt"),
            Array.from({ length: 300 }, (_, index) => `${index === 150 ? "poll update" : "changed line"} ${index}`).join("\n") + "\n",
        );
        await page.waitForFunction(() => document.querySelector("#diff")?.textContent?.includes("poll update"), null, { timeout: 8000 });
        check("background refresh updates selected diff", (await page.locator("#diff").textContent()).includes("poll update"), true);

        await writeFile(path.join(root, "polled.txt"), "arrived\n");
        await page.waitForSelector('button[data-path="polled.txt"]', { timeout: 8000 });
        check("polling discovers new file", await page.locator('button[data-path="polled.txt"]').count(), 1);

        const cleanPage = await openCanvas(browser, origin, cleanWorkspace.token);
        await cleanPage.waitForFunction(() => document.querySelector("#changes")?.textContent?.includes("Working tree clean."));
        check("clean state rendered", (await cleanPage.locator("#changes").textContent()).includes("Working tree clean."), true);

        const invalidPage = await openCanvas(browser, origin, "invalid-token");
        await invalidPage.waitForSelector("#error-overlay:not([hidden])");
        check("invalid token shows error", (await invalidPage.locator("#error-message").textContent()).includes("no longer registered"), true);

        console.log("\n=== floating lifecycle ===");
        const beforeDetach = await readChanges(root);
        const detachUrl = `${origin}/api/detach?w=${encodeURIComponent(workspace.token)}`;
        const [firstDetach, secondDetach] = await Promise.all([
            fetch(detachUrl, { method: "POST" }).then((response) => response.json()),
            fetch(detachUrl, { method: "POST" }).then((response) => response.json()),
        ]);
        check("floating window launched", ["app-window", "browser"].includes(firstDetach.mode), true);
        check("concurrent detach shares one launch", secondDetach.mode ?? secondDetach.alreadyDetached, firstDetach.mode ?? true);
        await page.waitForSelector("#floating-overlay:not([hidden])", { timeout: 8000 });
        check("panel overlay shown", await page.locator("#floating-overlay").isVisible(), true);
        const attached = await attachWorkspace(workspace);
        check("pop back in acknowledged", attached.ok, true);
        await page.waitForFunction(() => document.querySelector("#floating-overlay")?.hidden, null, { timeout: 8000 });

        const afterDetach = await readChanges(root);
        check("floating lifecycle is read-only", afterDetach.totals, beforeDetach.totals);
        check("no page errors", page.__errors, []);
        check("clean page has no errors", cleanPage.__errors, []);

        await Promise.all([page.close(), cleanPage.close(), invalidPage.close()]);
        releaseWorkspace(workspace);
        releaseWorkspace(cleanWorkspace);
        const released = await fetch(`${origin}/api/state?w=${encodeURIComponent(cleanWorkspace.token)}`);
        check("released workspace token is pruned", released.status, 400);
        workspace = null;
        cleanWorkspace = null;
    } finally {
        if (workspace) releaseWorkspace(workspace);
        if (cleanWorkspace) releaseWorkspace(cleanWorkspace);
        await browser.close();
        await removeFixture(root);
        await removeFixture(cleanRoot);
    }

    console.log(`\n${"=".repeat(60)}\n${passed} passed, ${failures.length} failed`);
    if (failures.length) failures.forEach((failure) => console.log(`  - ${failure}`));
    process.exit(failures.length ? 1 : 0);
}

await main();
