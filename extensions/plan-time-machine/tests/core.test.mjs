import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PlanError, PlanHistory, parseDiff } from "../history.mjs";
import { PlanTracker, MAX_PLAN_BYTES, MAX_PLAN_LINES } from "../tracker.mjs";
import { createPlanServer } from "../server.mjs";

const exec = promisify(execFile);
const first = "# Export plan\n\n## Access\nKeep regional access.\n\n## Delivery\nDownload immediately.\n";
const second = first.replace("Download immediately.", "Queue a background job.");
const third = second + "\n## Validation\nTest empty exports.\n";

async function fixture(t, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan-time-machine-test-"));
    const workspace = path.join(root, "session");
    await mkdir(workspace);
    const errors = [];
    const tracker = new PlanTracker(workspace, { captureDelayMs: 60000, onError: (error) => errors.push(error), ...options });
    let server = null;
    t.after(async () => {
        await server?.close();
        await tracker.dispose();
        await rm(root, { recursive: true, force: true });
    });
    await tracker.start();
    return {
        root, workspace, tracker, errors, plan: tracker.planPath,
        async serve() {
            server = await createPlanServer(tracker, { onError: (error) => errors.push(error) });
            return server;
        },
    };
}

async function eventually(check, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("Condition did not become true before the deadline.");
}

function http(url, { method = "GET", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = request(url, { method, headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.end();
    });
}

test("waits for native plan; captures real commits and preserves exact working/saved content", async (t) => {
    const { tracker, plan, workspace } = await fixture(t);
    let state = await tracker.refresh();
    assert.equal(state.status, "waiting");
    assert.equal(state.head, null);
    assert.equal(state.working, false);
    await writeFile(plan, first);
    state = await tracker.refresh();
    assert.equal(state.status, "ready");
    assert.equal(state.working, true);
    assert.ok(state.capture.dueAt);
    assert.equal((await tracker.revision("working")).diff.added, first.trimEnd().split("\n").length);
    state = await tracker.capture();
    const initial = state.head;
    assert.match(initial, /^[a-f0-9]{40}$/);
    assert.equal(state.history.entries[0].title, "Initial plan");
    assert.equal(state.working, false);
    assert.equal((await tracker.revision(initial)).content, first);
    assert.equal((await tracker.revision(initial)).parent, null);
    assert.equal((await tracker.revision("working")).diff.added, 0);
    assert.ok(tracker.store.repo.startsWith(path.join(workspace, "files", "plan-time-machine")));

    await writeFile(plan, second);
    state = await tracker.refresh();
    assert.equal(state.working, true);
    const working = await tracker.revision("working");
    assert.equal(working.parent, initial);
    assert.equal(working.diff.added, 1);
    assert.equal(working.diff.removed, 1);
    assert.equal((await tracker.revision(initial)).content, first);
    state = await tracker.capture();
    assert.equal(state.history.entries.length, 2);
    assert.equal(state.history.entries[0].parent, initial);
    assert.match(state.history.entries[0].title, /Delivery/);
    assert.equal(await readFile(plan, "utf8"), second);
    assert.equal((await tracker.revision(initial)).isLatest, false);
    await tracker.capture();
    assert.equal((await tracker.list()).entries.length, 2, "Identical captures must not create commits.");
});

test("history persists after tracker restart and is independent of renderer instances", async (t) => {
    const { tracker, plan, workspace } = await fixture(t);
    await writeFile(plan, first);
    const original = await tracker.capture();
    await writeFile(plan, second);
    await tracker.dispose();
    const resumed = new PlanTracker(workspace, { captureDelayMs: 60000, onError: () => {} });
    t.after(() => resumed.dispose());
    await resumed.start();
    assert.equal((await resumed.refresh()).head, original.head);
    assert.equal((await resumed.refresh()).working, true);
    assert.equal((await resumed.revision(original.head)).content, first);
    assert.equal((await resumed.revision("working")).content, second);
    await resumed.dispose();
});

test("captures settled edits automatically and groups rapid writes", async (t) => {
    const { tracker, plan } = await fixture(t, { captureDelayMs: 180, pollMs: 20 });
    await writeFile(plan, first);
    await tracker.refresh();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(plan, second);
    await tracker.refresh();
    assert.equal((await tracker.refresh()).head, null);
    await eventually(async () => (await tracker.refresh()).head !== null);
    const state = await tracker.refresh();
    assert.equal(state.history.entries.length, 1);
    assert.equal((await tracker.revision(state.head)).content, second);
    assert.equal(state.working, false);
});

test("handles atomic replacement, deletion, recreation, and empty plans without changing the native file", async (t) => {
    const { tracker, plan, workspace } = await fixture(t);
    await writeFile(plan, first);
    const original = await tracker.capture();
    const temp = path.join(workspace, "replacement.md");
    await writeFile(temp, second);
    await rename(temp, plan);
    assert.equal((await tracker.refresh()).working, true);
    await rm(plan);
    const missing = await tracker.refresh();
    assert.equal(missing.status, "missing");
    assert.equal(missing.head, original.head);
    assert.equal(missing.capture.dueAt, null);
    const deletion = await tracker.revision("working");
    assert.equal(deletion.exists, false);
    assert.equal(deletion.diff.added, 0);
    assert.ok(deletion.diff.removed > 0);
    assert.equal((await tracker.revision(original.head)).content, first);
    await writeFile(plan, first);
    assert.equal((await tracker.refresh()).working, false);
    await writeFile(plan, "");
    const empty = await tracker.capture();
    assert.equal((await tracker.revision(empty.head)).content, "");
    assert.equal((await tracker.refresh()).status, "ready");
    assert.equal(await readFile(plan, "utf8"), "");
});

test("refuses binary, malformed, oversized, and symlinked sources with recoverable visible errors", async (t) => {
    const { tracker, plan, root } = await fixture(t);
    await writeFile(plan, first);
    const baseline = await tracker.capture();
    for (const [contents, code] of [
        [Buffer.from([0, 1, 2]), "invalid_plan"],
        [Buffer.from([0xff, 0xfe, 0xff]), "invalid_plan"],
        ["x".repeat(MAX_PLAN_BYTES + 1), "plan_too_large"],
        ["\n".repeat(MAX_PLAN_LINES), "plan_too_large"],
    ]) {
        await writeFile(plan, contents);
        const state = await tracker.refresh();
        assert.equal(state.status, "error");
        assert.equal(state.error.code, code);
        assert.equal(state.head, baseline.head);
        await assert.rejects(tracker.revision("working"), { code });
    }
    await rm(plan);
    await mkdir(plan);
    assert.equal((await tracker.refresh()).error.code, "unsafe_plan");
    await rm(plan, { recursive: true });
    const target = path.join(root, "unrelated.txt");
    await writeFile(target, "Do not capture this.");
    try {
        await symlink(target, plan, "file");
        assert.equal((await tracker.refresh()).error.code, "unsafe_plan");
        await rm(plan);
    } catch (error) {
        if (error.code !== "EPERM") throw error;
        t.diagnostic("File symlink creation is unavailable on this Windows host.");
    }
    await writeFile(plan, second);
    const recovered = await tracker.refresh();
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.error, null);
    assert.equal((await tracker.capture()).history.entries.length, 2);
    assert.equal(await readFile(target, "utf8"), "Do not capture this.");
    await writeFile(plan, "x".repeat(MAX_PLAN_BYTES));
    assert.equal((await tracker.refresh()).status, "ready", "Exactly 1 MiB is supported.");
    await writeFile(plan, "\n".repeat(MAX_PLAN_LINES - 1));
    assert.equal((await tracker.refresh()).status, "ready", "Exactly 20,000 lines is supported.");
});

test("preserves UTF-8 BOM, CRLF, Unicode and missing final newline in snapshots", async (t) => {
    const { tracker, plan } = await fixture(t);
    const source = "\uFEFF# Plan\r\n\r\n## R\u00e9gion\r\nCustomer \u2713";
    await writeFile(plan, source);
    const state = await tracker.capture();
    assert.equal(state.title, "Plan");
    assert.equal((await tracker.revision(state.head)).content, source);
    assert.deepEqual(await readFile(plan), Buffer.from(source));
    await writeFile(plan, source + "\r\n");
    const changed = await tracker.revision("working");
    assert.ok(changed.diff.lines.some((line) => line.type === "notice"));
});

test("pagination, revision validation and concurrent captures keep a single linear plan history", async (t) => {
    const { tracker, workspace } = await fixture(t);
    for (let index = 0; index < 5; index++) await tracker.store.capture(`# Plan ${index}\n`);
    const firstPage = await tracker.store.list(null, 2);
    assert.equal(firstPage.entries.length, 2);
    assert.equal(firstPage.nextCursor, firstPage.entries.at(-1).id);
    const secondPage = await tracker.store.list(firstPage.nextCursor, 2);
    const finalPage = await tracker.store.list(secondPage.nextCursor, 2);
    assert.equal(finalPage.entries.length, 1);
    assert.equal(finalPage.nextCursor, null);
    assert.equal(new Set([...firstPage.entries, ...secondPage.entries, ...finalPage.entries].map((entry) => entry.id)).size, 5);
    await assert.rejects(tracker.store.revision("../../plan.md"), { code: "invalid_revision" });
    await assert.rejects(tracker.store.revision("a".repeat(40)), { code: "revision_not_found" });
    const foreignBlob = await tracker.store.blob("Not a commit.");
    await assert.rejects(tracker.store.revision(foreignBlob), { code: "revision_not_found" });
    const another = new PlanHistory(workspace);
    await another.initialize();
    const captures = await Promise.all([tracker.store.capture(third), another.capture(third)]);
    assert.equal(captures[0], captures[1]);
    const history = await tracker.store.list();
    assert.equal(history.entries.length, 6);
    assert.equal(history.entries[0].parent, firstPage.entries[0].id);
});

test("uses isolated Git storage and ignores ambient repository configuration", async (t) => {
    const { tracker, root, plan } = await fixture(t);
    const code = path.join(root, "code");
    await mkdir(code);
    await exec("git", ["init", "--template=", code], { windowsHide: true });
    await writeFile(path.join(code, "app.txt"), "Uncommitted application work.");
    const before = (await exec("git", ["-C", code, "status", "--porcelain=v1"], { windowsHide: true })).stdout;
    await writeFile(plan, first);
    await tracker.capture();
    const historyModule = new URL("../history.mjs", import.meta.url).href;
    await exec(process.execPath, [
        "--input-type=module", "-e",
        `import {PlanHistory} from ${JSON.stringify(historyModule)}; const store=new PlanHistory(${JSON.stringify(tracker.workspacePath)}); await store.initialize(); await store.capture("# Isolated capture\\n");`,
    ], {
        windowsHide: true,
        env: {
            ...process.env,
            GIT_DIR: path.join(code, ".git"),
            GIT_WORK_TREE: code,
            GIT_INDEX_FILE: path.join(code, "must-not-create.index"),
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "user.name",
            GIT_CONFIG_VALUE_0: "Wrong identity",
        },
    });
    const after = (await exec("git", ["-C", code, "status", "--porcelain=v1"], { windowsHide: true })).stdout;
    assert.equal(before, after);
    assert.match(after, /\?\? app.txt/);
    assert.equal(await tracker.store.git(["remote"]), "");
    assert.equal((await tracker.store.git(["show", "-s", "--format=%an", "refs/heads/main"])).trim(), "Plan Time Machine");
    assert.deepEqual((await tracker.store.git(["ls-tree", "--name-only", "refs/heads/main"])).trim().split("\n"), ["plan.md"]);
});

test("HTTP server authenticates data, validates origin/host, and only captures into history", async (t) => {
    const fixtureA = await fixture(t);
    const fixtureB = await fixture(t);
    const serverA = await fixtureA.serve();
    const serverB = await fixtureB.serve();
    const headers = { "X-Plan-Token": serverA.token };
    assert.equal((await http(`${serverA.origin}/api/state`)).status, 401);
    assert.equal((await http(`${serverA.origin}/api/state`, { headers: { "X-Plan-Token": serverB.token } })).status, 401);
    assert.equal((await http(`${serverA.origin}/api/state`, { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
    assert.equal((await http(`${serverA.origin}/api/state`, { headers: { ...headers, Host: "example.invalid" } })).status, 403);
    const status = await http(`${serverA.origin}/api/state`, { headers });
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).status, "waiting");
    assert.equal(status.headers["cache-control"], "no-store");
    assert.equal(status.headers["access-control-allow-origin"], undefined);
    assert.match(status.headers["content-security-policy"], /img-src 'none'/);
    assert.equal((await http(`${serverA.origin}/api/revision?id=..%2F..%2Fsecret`, { headers })).status, 400);
    assert.equal((await http(`${serverA.origin}/api/capture`, { method: "POST", headers })).status, 403);
    await writeFile(fixtureA.plan, first);
    const captured = await http(`${serverA.origin}/api/capture`, { method: "POST", headers: { ...headers, Origin: serverA.origin } });
    assert.equal(captured.status, 200);
    const state = JSON.parse(captured.body);
    assert.ok(state.head);
    assert.equal((await http(`${serverA.origin}/api/revision?id=${state.head}`, { headers })).status, 200);
    assert.equal(await readFile(fixtureA.plan, "utf8"), first);
    assert.equal((await fixtureB.tracker.refresh()).head, null);
    assert.equal((await http(`${serverA.origin}/api/delete`, { method: "POST", headers })).status, 405);
});

test("native diff parser handles content that resembles diff headers", () => {
    const diff = parseDiff("diff --git a/plan.md b/plan.md\n--- a/plan.md\n+++ b/plan.md\n@@ -1 +1,2 @@\n--- old text\n+++ new text\n+another line\n\\ No newline at end of file\n");
    assert.equal(diff.added, 2);
    assert.equal(diff.removed, 1);
    assert.equal(diff.lines.find((line) => line.type === "remove").text, "-- old text");
    assert.equal(diff.lines.find((line) => line.type === "add").text, "++ new text");
});

test("capture failures stay visible until a successful retry", async (t) => {
    const { tracker, plan } = await fixture(t);
    await writeFile(plan, first);
    await tracker.capture();
    await writeFile(plan, second);
    const capture = tracker.store.capture.bind(tracker.store);
    tracker.store.capture = async () => { throw new PlanError("git_failed", "Simulated unavailable history storage."); };
    await assert.rejects(tracker.capture(), { code: "git_failed" });
    assert.equal((await tracker.refresh()).status, "error");
    assert.equal((await tracker.refresh()).error.message, "Simulated unavailable history storage.");
    assert.equal(await readFile(plan, "utf8"), second);
    tracker.store.capture = capture;
    const recovered = await tracker.capture();
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.error, null);
    assert.equal(recovered.history.entries.length, 2);
});

test("rejects unavailable session paths and storage links outside the session", async (t) => {
    assert.throws(() => new PlanTracker(undefined), { code: "workspace_unavailable" });
    assert.throws(() => new PlanTracker("relative-path"), { code: "workspace_unavailable" });
    const { root } = await fixture(t);
    const workspace = path.join(root, "linked-session");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(outside, "sentinel.txt"), "Keep this file.");
    try {
        await symlink(outside, path.join(workspace, "files"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error.code !== "EPERM") throw error;
        t.skip("Directory links are not supported by this host.");
        return;
    }
    const history = new PlanHistory(workspace);
    await assert.rejects(history.initialize(), { code: "unsafe_storage" });
    assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "Keep this file.");
});
