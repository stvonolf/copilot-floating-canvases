import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { request } from "node:http";
import test from "node:test";
import { ReviewStore, REVIEW_LIMITS } from "../review.mjs";
import { ensureServer, registerWorkspace, retainWorkspace, releaseWorkspace } from "../server.mjs";

const exec = promisify(execFile);
async function git(root, ...args) {
    return (await exec("git", args, { cwd: root, encoding: "utf8", windowsHide: true })).stdout;
}
const digest = (data) => createHash("sha256").update(data).digest("hex");

async function fixture(t, options = {}) {
    const temp = await mkdtemp(path.join(os.tmpdir(), "since-looked-test-"));
    const root = path.join(temp, "repo");
    const session = path.join(temp, "session");
    await mkdir(root);
    await mkdir(session);
    await git(root, "init", "--template=", "-b", "main");
    await git(root, "config", "user.name", "Review Test");
    await git(root, "config", "user.email", "review@example.test");
    await git(root, "config", "core.autocrlf", "false");
    await writeFile(path.join(root, ".gitignore"), "ignored/\n*.log\n");
    await writeFile(path.join(root, "a.txt"), "line one\nline two\n");
    await writeFile(path.join(root, "b.txt"), "stable\n");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "unicode name.txt"), "Initial\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "base");
    const store = await new ReviewStore(root, session, options).initialize();
    t.after(() => rm(temp, { recursive: true, force: true }));
    return { root, session, store, temp, file: (name) => path.join(root, name) };
}

async function initialCheckpoint(store) {
    return store.markReviewed((await store.state()).viewId);
}

test("explicit review starts a baseline; only subsequent exact content changes appear", async (t) => {
    const { store, file } = await fixture(t);
    await writeFile(file("a.txt"), "already changed\n");
    const before = await store.state();
    assert.equal(before.checkpoint, null);
    assert.deepEqual(before.files, []);
    assert.match(before.viewId, /^[a-f0-9]{64}$/);
    const reviewed = await store.markReviewed(before.viewId);
    assert.ok(reviewed.checkpoint);
    assert.equal(reviewed.counts.files, 0);
    await writeFile(file("a.txt"), "already changed\nnew since review\n");
    await writeFile(file("new.txt"), "untracked content\n");
    await rm(file("b.txt"));
    const changes = await store.state();
    assert.deepEqual(changes.files.map((entry) => [entry.path, entry.status]), [
        ["a.txt", "Modified"], ["b.txt", "Deleted"], ["new.txt", "Added"],
    ]);
    const diff = await store.diff("a.txt", changes.viewId);
    assert.match(diff.diff, /\+new since review/);
    assert.doesNotMatch(diff.diff, /-line one/);
    assert.equal(changes.counts.additions, 2);
    assert.equal(changes.counts.deletions, 1);
    const next = await store.markReviewed(changes.viewId);
    assert.notEqual(next.checkpoint.id, reviewed.checkpoint.id);
    assert.equal(next.counts.files, 0);
});

test("moving between staged, unstaged and committed does not reintroduce reviewed content", async (t) => {
    const { root, store, file } = await fixture(t);
    await writeFile(file("a.txt"), "reviewed staged\n");
    await git(root, "add", "a.txt");
    await writeFile(file("a.txt"), "reviewed staged\nreviewed unstaged\n");
    await writeFile(file("new.txt"), "reviewed untracked\n");
    const checkpoint = await initialCheckpoint(store);
    await git(root, "add", ".");
    const staged = await store.state();
    assert.equal(staged.viewId, checkpoint.viewId);
    await git(root, "commit", "-m", "commit reviewed contents");
    assert.equal((await store.state()).viewId, checkpoint.viewId);
    await writeFile(file("a.txt"), "reviewed staged\nreviewed unstaged\nlater edit\n");
    assert.equal((await store.state()).counts.files, 1);
    const diff = await store.diff("a.txt", (await store.state()).viewId);
    assert.equal((diff.diff.match(/^\+later edit$/gm) ?? []).length, 1);
});

test("checkpoint rejects edits not present in the displayed view and immutable diff uses shown contents", async (t) => {
    const { store, file } = await fixture(t);
    const first = await initialCheckpoint(store);
    await writeFile(file("a.txt"), "visible change\n");
    const visible = await store.state();
    await writeFile(file("a.txt"), "unseen change\n");
    await assert.rejects(store.markReviewed(visible.viewId), { code: "stale_view" });
    assert.equal((await store.state()).checkpoint.id, first.checkpoint.id);
    const shownDiff = await store.diff("a.txt", visible.viewId);
    assert.match(shownDiff.diff, /visible change/);
    assert.doesNotMatch(shownDiff.diff, /unseen change/);
    await assert.rejects(store.diff("../other.txt", visible.viewId), { code: "invalid_review_path" });
    await assert.rejects(store.diff("b.txt", visible.viewId), { code: "review_path_not_found" });
    await assert.rejects(store.markReviewed("not-a-view"), { code: "stale_view" });
    const refreshed = await store.state();
    assert.equal((await store.markReviewed(refreshed.viewId)).counts.files, 0);
});

test("full baseline detects modifications to initially clean files and new files after reopen", async (t) => {
    const { root, session, store, file } = await fixture(t);
    const baseline = await initialCheckpoint(store);
    const reopened = await new ReviewStore(root, session).initialize();
    await writeFile(file("nested/unicode name.txt"), "later\n");
    await writeFile(file("after-reopen.txt"), "new\n");
    const state = await reopened.state();
    assert.equal(state.checkpoint.id, baseline.checkpoint.id);
    assert.deepEqual(state.files.map((entry) => entry.path), ["after-reopen.txt", "nested/unicode name.txt"]);
    const otherSession = path.join(path.dirname(session), "other-session");
    await mkdir(otherSession);
    const isolated = await new ReviewStore(root, otherSession).initialize();
    assert.equal((await isolated.state()).checkpoint, null);
});

test("feedback persists independently of checkpoints, records changed files and resolves explicitly", async (t) => {
    const { root, session, store, file } = await fixture(t);
    await initialCheckpoint(store);
    await writeFile(file("a.txt"), "needs a check\n");
    const view = await store.state();
    let state = await store.addFeedback({ viewId: view.viewId, path: "a.txt", text: "Please preserve whitespace." });
    const note = state.feedback[0];
    assert.equal(note.status, "open");
    assert.equal(note.changedSinceComment, false);
    await writeFile(file("a.txt"), "addressed perhaps\n");
    state = await store.state();
    assert.equal(state.feedback[0].changedSinceComment, true);
    state = await store.markReviewed(state.viewId);
    assert.equal(state.files.length, 0);
    assert.equal(state.feedback[0].status, "open");
    const reopened = await new ReviewStore(root, session).initialize();
    state = await reopened.state();
    assert.equal(state.feedback[0].id, note.id);
    const version = state.feedbackVersion;
    state = await reopened.setFeedback({ id: note.id, status: "resolved", feedbackVersion: version });
    assert.equal(state.feedback[0].status, "resolved");
    assert.ok(state.feedback[0].resolvedAt);
    await assert.rejects(store.setFeedback({ id: note.id, status: "open", feedbackVersion: version }), { code: "stale_feedback" });
    state = await store.setFeedback({ id: note.id, status: "open", feedbackVersion: state.feedbackVersion });
    assert.equal(state.feedback[0].resolvedAt, null);
    await rm(file("a.txt"));
    state = await reopened.state();
    assert.equal(state.feedback[0].status, "open");
    assert.equal(state.feedback[0].changedSinceComment, true);
    await assert.rejects(store.addFeedback({ viewId: state.viewId, path: "a.txt", text: " " }), { code: "invalid_feedback" });
    await assert.rejects(store.addFeedback({ viewId: state.viewId, path: "a.txt", text: "a".repeat(2001) }), { code: "invalid_feedback" });
});

test("separate panels cannot overwrite newer checkpoints or feedback", async (t) => {
    const { store, root, session } = await fixture(t);
    const second = await new ReviewStore(root, session).initialize();
    const old = await second.state();
    await initialCheckpoint(store);
    await assert.rejects(second.markReviewed(old.viewId), { code: "stale_view" });
    await assert.rejects(second.addFeedback({ viewId: old.viewId, path: "a.txt", text: "Outdated" }), { code: "stale_view" });
    assert.equal((await second.state()).feedback.length, 0);
});

test("renames, binary files, CRLF, final newlines, ignored files, and unusual names", async (t) => {
    const { store, file } = await fixture(t);
    const unusual = "literal [name] \u00e9.txt";
    await writeFile(file(unusual), "bom and CRLF\r\n");
    await writeFile(file("binary.bin"), Buffer.from([0, 1, 2]));
    await initialCheckpoint(store);
    await rename(file("b.txt"), file("renamed.txt"));
    await writeFile(file(unusual), "bom and CRLF\r\nlast");
    await writeFile(file("binary.bin"), Buffer.from([0, 1, 3]));
    await writeFile(file("debug.log"), "ignored new file");
    await mkdir(file("ignored"));
    await writeFile(file("ignored/private.txt"), "ignored contents");
    const state = await store.state();
    const renamed = state.files.find((entry) => entry.path === "renamed.txt");
    assert.equal(renamed.oldPath, "b.txt");
    assert.equal(renamed.status, "Renamed");
    assert.equal(state.files.find((entry) => entry.path === "binary.bin").binary, true);
    assert.ok(!state.files.some((entry) => /ignored|debug/.test(entry.path)));
    const diff = await store.diff(unusual, state.viewId);
    assert.match(diff.diff, /No newline at end of file/);
    assert.match((await store.diff("renamed.txt", state.viewId)).diff, /rename from/);
});

test("does not modify working files, HEAD, index, refs or local Git configuration", async (t) => {
    const { root, store, file } = await fixture(t);
    await writeFile(file("a.txt"), "staged\n");
    await git(root, "add", "a.txt");
    await writeFile(file("a.txt"), "staged\nunstaged\n");
    const controlPaths = [".git/index", ".git/HEAD", ".git/config", ".git/refs/heads/main", "a.txt", "b.txt"];
    const before = await Promise.all(controlPaths.map(async (name) => digest(await readFile(file(name)))));
    const head = await git(root, "show-ref");
    const baseline = await initialCheckpoint(store);
    await store.addFeedback({ viewId: baseline.viewId, path: "a.txt", text: "Inspect this file." });
    await store.state();
    assert.deepEqual(await Promise.all(controlPaths.map(async (name) => digest(await readFile(file(name))))), before);
    assert.equal(await git(root, "show-ref"), head);
    assert.equal(await store.git(["remote"]), "");
});

test("limits fail explicitly and cannot advance a partial checkpoint", async (t) => {
    const limits = { ...REVIEW_LIMITS, fileBytes: 120, totalBytes: 500 };
    const { store, file } = await fixture(t, { limits });
    const baseline = await initialCheckpoint(store);
    await writeFile(file("large.txt"), "a".repeat(121));
    await assert.rejects(store.state(), { code: "review_limit" });
    await assert.rejects(store.markReviewed(baseline.viewId), { code: "review_limit" });
    assert.equal((await store.metadata()).checkpoint.id, baseline.checkpoint.id);
    await writeFile(file("large.txt"), "a".repeat(120));
    assert.ok((await store.state()).files.some((entry) => entry.path === "large.txt"));
    for (let i = 0; i < 4; i++) await writeFile(file(`full-${i}.txt`), "a".repeat(120));
    await assert.rejects(store.state(), { code: "review_limit" });
    assert.equal((await store.metadata()).checkpoint.id, baseline.checkpoint.id);
});

test("rejects conflicts, sparse trees, and gitlinks rather than claiming complete review", async (t) => {
    const { root, store } = await fixture(t);
    await git(root, "update-index", "--skip-worktree", "a.txt");
    await assert.rejects(store.state(), { code: "sparse_not_supported" });
    await git(root, "update-index", "--no-skip-worktree", "a.txt");
    const head = (await git(root, "rev-parse", "HEAD")).trim();
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${head},module`);
    await assert.rejects(store.state(), { code: "submodule_not_supported" });
    await git(root, "update-index", "--force-remove", "module");
    await git(root, "checkout", "-b", "other");
    await writeFile(path.join(root, "a.txt"), "other\n");
    await git(root, "add", "a.txt");
    await git(root, "commit", "-m", "other");
    await git(root, "checkout", "main");
    await writeFile(path.join(root, "a.txt"), "main\n");
    await git(root, "add", "a.txt");
    await git(root, "commit", "-m", "main");
    await assert.rejects(git(root, "merge", "other"));
    await assert.rejects(store.state(), { code: "unresolved_conflicts" });
});

test("linked parent paths and storage are never traversed", async (t) => {
    const { store, file, temp, root } = await fixture(t);
    const outside = path.join(temp, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "unicode name.txt"), "Do not review this");
    await rm(file("nested"), { recursive: true });
    try {
        await symlink(outside, file("nested"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
        if (error.code !== "EPERM") throw error;
        t.skip("Host cannot create directory links.");
        return;
    }
    await assert.rejects(store.state(), { code: "unsafe_review_path" });
    const session = path.join(temp, "linked-session");
    await mkdir(session);
    await symlink(outside, path.join(session, "files"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(new ReviewStore(root, session).initialize(), { code: "unsafe_review_storage" });
    assert.equal(await readFile(path.join(outside, "unicode name.txt"), "utf8"), "Do not review this");
});

test("supports unborn repositories and directory deletions", async (t) => {
    const { temp, session } = await fixture(t);
    const root = path.join(temp, "unborn");
    await mkdir(root);
    await git(root, "init", "--template=");
    await writeFile(path.join(root, "untracked.txt"), "only untracked\n");
    const store = await new ReviewStore(root, session).initialize();
    await initialCheckpoint(store);
    await rm(path.join(root, "untracked.txt"));
    const state = await store.state();
    assert.equal(state.files[0].status, "Deleted");
});

test("detects writes during a snapshot without advancing the checkpoint", async (t) => {
    const { store, file } = await fixture(t);
    const baseline = await initialCheckpoint(store);
    const inspect = store.inspect.bind(store);
    let injected = false;
    store.inspect = async (name, mode) => {
        const result = await inspect(name, mode);
        if (!injected && name === "b.txt") {
            injected = true;
            await writeFile(file("a.txt"), "changed during snapshot\n");
        }
        return result;
    };
    await assert.rejects(store.markReviewed(baseline.viewId), { code: "tree_changing" });
    assert.equal((await store.metadata()).checkpoint.id, baseline.checkpoint.id);
    store.inspect = inspect;
    assert.equal((await store.state()).counts.files, 1);
});

test("HTTP review writes require origin, token header, valid JSON and a fresh view", async (t) => {
    const { root, session, file } = await fixture(t);
    const workspace = await registerWorkspace(root, { sessionWorkspace: session });
    retainWorkspace(workspace);
    const server = await ensureServer();
    t.after(async () => { releaseWorkspace(workspace); await server.close(); });
    const url = (route) => `${server.origin}/api/review/${route}?w=${workspace.token}`;
    const headers = { Origin: server.origin, "X-Review-Token": workspace.token, "Content-Type": "application/json" };
    const before = await (await fetch(url("state"))).json();
    assert.equal(before.checkpoint, null);
    assert.equal((await fetch(url("checkpoint"), { method: "POST", body: JSON.stringify({ viewId: before.viewId }) })).status, 400);
    assert.equal((await fetch(url("checkpoint"), {
        method: "POST", headers: { ...headers, Origin: "https://example.invalid" }, body: JSON.stringify({ viewId: before.viewId }),
    })).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
        const req = request(url("state"), { headers: { Host: "example.invalid" } }, (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
        });
        req.on("error", reject);
        req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal((await fetch(`${server.origin}/api/review/state?w=wrong-token`)).status, 400);
    const mark = await fetch(url("checkpoint"), { method: "POST", headers, body: JSON.stringify({ viewId: before.viewId }) });
    assert.equal(mark.status, 200);
    const baseline = await mark.json();
    await writeFile(file("a.txt"), "after view\n");
    const stale = await fetch(url("checkpoint"), { method: "POST", headers, body: JSON.stringify({ viewId: baseline.viewId }) });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "stale_view");
    const visible = await (await fetch(url("state"))).json();
    const note = await fetch(url("feedback"), { method: "POST", headers, body: JSON.stringify({
        viewId: visible.viewId, path: "a.txt", text: "<script>not executable</script>",
    }) });
    assert.equal(note.status, 200);
    const noted = await note.json();
    assert.equal(noted.feedback.length, 1);
    assert.equal((await fetch(url("feedback/status"), { method: "POST", headers, body: JSON.stringify({
        id: noted.feedback[0].id, status: "resolved", feedbackVersion: 0,
    }) })).status, 409);
    assert.equal(await readFile(file("a.txt"), "utf8"), "after view\n");
    assert.equal((await fetch(url("checkpoint"), { method: "POST", headers, body: "[" })).status, 400);
});

test("tracks ordinary directory-to-file and file-to-directory replacements", async (t) => {
    const { store, file } = await fixture(t);
    await initialCheckpoint(store);
    await rm(file("nested"), { recursive: true });
    await writeFile(file("nested"), "directory replaced by file\n");
    let state = await store.state();
    assert.deepEqual(state.files.map((entry) => [entry.path, entry.status]), [
        ["nested", "Added"], ["nested/unicode name.txt", "Deleted"],
    ]);
    const added = await store.diff("nested", state.viewId);
    assert.match(added.diff, /\+directory replaced by file/);
    assert.doesNotMatch(added.diff, /unicode name/);
    const deleted = await store.diff("nested/unicode name.txt", state.viewId);
    assert.doesNotMatch(deleted.diff, /\+directory replaced by file/);
    await store.markReviewed(state.viewId);
    await rm(file("a.txt"));
    await mkdir(file("a.txt"));
    await writeFile(file("a.txt/child.txt"), "file replaced by directory\n");
    state = await store.state();
    assert.deepEqual(state.files.map((entry) => [entry.path, entry.status]), [
        ["a.txt", "Deleted"], ["a.txt/child.txt", "Added"],
    ]);
    assert.doesNotMatch((await store.diff("a.txt", state.viewId)).diff, /child.txt/);
    await store.markReviewed(state.viewId);
    assert.equal((await store.state()).counts.files, 0);
});
