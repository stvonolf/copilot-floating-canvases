import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { lstat, mkdir, open, readFile, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GitError, parseNumstat } from "./git.mjs";

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const NULL_FILE = process.platform === "win32" ? "NUL" : os.devNull;
export const REVIEW_LIMITS = { files: 10000, fileBytes: 16 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, feedback: 1000 };

function fail(code, message) {
    throw new GitError(code, message);
}

function relativeName(name) {
    if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\") ||
        name.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
        path.isAbsolute(name) || /^[a-z]:/i.test(name)) {
        fail("invalid_review_path", "The review path is not a repository-relative file.");
    }
    return name;
}

async function safeDirectory(parent, name) {
    const target = path.join(parent, name);
    try {
        await mkdir(target, { mode: 0o700 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe_review_storage", `Review storage is not a regular directory: ${target}`);
    return target;
}

function environment() {
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_FILE,
        GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
    };
}

function signature(info, includeChangeTime = true) {
    return [info.dev, info.ino, info.size, info.mtimeNs, ...(includeChangeTime ? [info.ctimeNs] : []), info.mode].map(String).join(":");
}

export class ReviewStore {
    constructor(root, sessionWorkspace, { limits = REVIEW_LIMITS } = {}) {
        this.root = root;
        this.sessionWorkspace = sessionWorkspace;
        this.limits = limits;
        this.queue = Promise.resolve();
        this.views = new Map();
        this.blobs = new Map();
        this.treeFiles = new Map();
        this.directory = null;
    }

    async initialize() {
        if (!this.sessionWorkspace || !path.isAbsolute(this.sessionWorkspace)) {
            fail("review_unavailable", "The SDK did not provide a session workspace for review checkpoints.");
        }
        this.root = await realpath(this.root);
        const session = await realpath(this.sessionWorkspace);
        const files = await safeDirectory(session, "files");
        const storage = await safeDirectory(files, "floating-changes-review");
        this.directory = await safeDirectory(storage, hash(this.root));
        const relative = path.relative(this.root, this.directory);
        if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
            fail("unsafe_review_storage", "Review storage must be outside the reviewed repository.");
        }
        this.repo = await safeDirectory(this.directory, "objects.git");
        this.statePath = path.join(this.directory, "review.json");
        try {
            const head = await lstat(path.join(this.repo, "HEAD"));
            if (!head.isFile() || head.isSymbolicLink()) fail("unsafe_review_storage", "Invalid review Git metadata.");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await this.git(["init", "--bare", "--template=", "--object-format=sha1", "--initial-branch=review"]);
        }
        if ((await this.git(["rev-parse", "--is-bare-repository"])).trim() !== "true") {
            fail("unsafe_review_storage", "Review snapshots require a separate bare Git object store.");
        }
        return this;
    }

    run(action) {
        const result = this.queue.then(action);
        this.queue = result.catch(() => {});
        return result;
    }

    async git(args, source = false) {
        try {
            return (await exec("git", [
                "--no-optional-locks", "--literal-pathspecs",
                ...(source ? [] : [`--git-dir=${this.repo}`]),
                "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
                "-c", `core.attributesFile=${NULL_FILE}`,
                ...args,
            ], { cwd: source ? this.root : this.directory, env: environment(), timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })).stdout;
        } catch (error) {
            fail("review_git_failed", String(error.stderr || error.message).trim());
        }
    }

    async object(type, content) {
        const body = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
        const id = createHash("sha1").update(body).digest("hex");
        const objects = await safeDirectory(this.repo, "objects");
        const folder = await safeDirectory(objects, id.slice(0, 2));
        const file = path.join(folder, id.slice(2));
        try {
            const existing = await lstat(file);
            if (!existing.isFile() || existing.isSymbolicLink()) fail("unsafe_review_storage", "Invalid snapshot object.");
            return id;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const temp = path.join(folder, `tmp-${randomUUID()}`);
        try {
            await writeFile(temp, deflateSync(body), { flag: "wx", mode: 0o600 });
            await rename(temp, file);
        } finally {
            try { await unlink(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        return id;
    }

    async inventory() {
        const [tracked, untracked] = await Promise.all([
            this.git(["ls-files", "--stage", "-z"], true),
            this.git(["ls-files", "--others", "--exclude-standard", "-z"], true),
        ]);
        const entries = new Map();
        for (const record of tracked.split("\0").filter(Boolean)) {
            const tab = record.indexOf("\t");
            const [mode, , stage] = record.slice(0, tab).split(" ");
            const name = relativeName(record.slice(tab + 1));
            if (stage !== "0") fail("unresolved_conflicts", "Resolve Git conflicts before creating or comparing review checkpoints.");
            if (mode === "160000") fail("submodule_not_supported", "Review checkpoints do not include submodules. Use Git changes to review this repository.");
            entries.set(name, mode);
        }
        for (const name of untracked.split("\0").filter(Boolean)) entries.set(relativeName(name), null);
        if (entries.size > this.limits.files) fail("review_limit", `Review is limited to ${this.limits.files.toLocaleString()} files. No checkpoint was advanced.`);
        const sparse = await this.git(["ls-files", "-v", "-z"], true);
        if (sparse.split("\0").some((record) => /^[Ss] /.test(record))) {
            fail("sparse_not_supported", "Review checkpoints require a complete working tree; skip-worktree entries are not supported.");
        }
        return [...entries].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    }

    async inspect(name, mode) {
        const segments = relativeName(name).split("/");
        let current = this.root;
        for (const segment of segments.slice(0, -1)) {
            current = path.join(current, segment);
            try {
                const info = await lstat(current);
                if (info.isSymbolicLink()) fail("unsafe_review_path", `Cannot traverse a linked parent directory: ${name}`);
                if (!info.isDirectory()) return null;
            } catch (error) {
                if (error.code === "ENOENT") return null;
                throw error;
            }
        }
        const file = path.join(current, segments.at(-1));
        let info;
        try {
            info = await lstat(file, { bigint: true });
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        const key = signature(info);
        if (info.isSymbolicLink()) {
            const target = await readlink(file);
            if (signature(await lstat(file, { bigint: true })) !== key) fail("tree_changing", `File changed while reading: ${name}. Refresh and try again.`);
            return { mode: "120000", content: Buffer.from(target), key, size: Buffer.byteLength(target) };
        }
        if (info.isDirectory() && mode !== null) return null;
        if (!info.isFile()) fail("unsupported_review_file", `Cannot snapshot this file type: ${name}`);
        if (info.size > BigInt(this.limits.fileBytes)) fail("review_limit", `${name} exceeds the ${this.limits.fileBytes / 1024 / 1024} MiB per-file review limit.`);
        const fileMode = process.platform === "win32" ? mode || "100644" : info.mode & 0o111n ? "100755" : "100644";
        const cached = this.blobs.get(name);
        if (cached?.key === key && cached.mode === fileMode) return { ...cached, size: Number(info.size) };
        const handle = await open(file, "r");
        try {
            // Windows may update ctime on open without changing content. Keep it for
            // cache invalidation, but compare file identity/mtime while reading.
            const openedInfo = await handle.stat({ bigint: true });
            if (signature(openedInfo, false) !== signature(info, false)) fail("tree_changing", `File changed while opening: ${name}.`);
            const buffer = Buffer.alloc(Number(info.size) + 1);
            let length = 0;
            while (length < buffer.length) {
                const read = await handle.read(buffer, length, buffer.length - length, length);
                if (!read.bytesRead) break;
                length += read.bytesRead;
            }
            const finalInfo = await lstat(file, { bigint: true });
            if (length !== Number(info.size) || signature(await handle.stat({ bigint: true }), false) !== signature(info, false) ||
                signature(finalInfo, false) !== signature(info, false)) {
                fail("tree_changing", `File changed while reading: ${name}. Refresh before marking reviewed.`);
            }
            return { mode: fileMode, content: buffer.subarray(0, length), key: signature(finalInfo), size: length };
        } finally {
            await handle.close();
        }
    }

    async snapshot() {
        const inventory = await this.inventory();
        const entries = [];
        const observed = new Map();
        let total = 0;
        for (const [name, mode] of inventory) {
            const file = await this.inspect(name, mode);
            observed.set(name, null);
            if (!file) continue;
            total += file.size;
            if (total > this.limits.totalBytes) fail("review_limit", `Review content exceeds ${this.limits.totalBytes / 1024 / 1024} MiB. No checkpoint was advanced.`);
            const id = file.id ?? await this.object("blob", file.content);
            observed.set(name, `${file.mode}:${id}`);
            this.blobs.set(name, { id, mode: file.mode, key: file.key });
            entries.push({ path: name, id, mode: file.mode });
        }
        const present = new Set(inventory.map(([name]) => name));
        for (const name of this.blobs.keys()) if (!present.has(name)) this.blobs.delete(name);
        if (JSON.stringify(await this.inventory()) !== JSON.stringify(inventory)) {
            fail("tree_changing", "The repository file inventory changed during review. Refresh and try again.");
        }
        for (const [name, mode] of inventory) {
            const file = await this.inspect(name, mode);
            const identity = file ? `${file.mode}:${file.id ?? await this.object("blob", file.content)}` : null;
            if (identity !== observed.get(name)) fail("tree_changing", `File changed during review: ${name}. Refresh and try again.`);
        }
        const id = await this.tree(entries);
        return { id, files: new Map(entries.map((entry) => [entry.path, entry])), count: entries.length };
    }

    async tree(entries) {
        const tree = { children: new Map() };
        for (const entry of entries) {
            const parts = entry.path.split("/");
            let node = tree;
            for (const part of parts.slice(0, -1)) {
                if (!node.children.has(part)) node.children.set(part, { children: new Map() });
                node = node.children.get(part);
            }
            node.children.set(parts.at(-1), entry);
        }
        const build = async (node) => {
            const items = [...node.children].sort(([a, av], [b, bv]) =>
                Buffer.compare(Buffer.from(a + (av.children ? "/" : "")), Buffer.from(b + (bv.children ? "/" : ""))));
            const chunks = [];
            for (const [name, value] of items) {
                const mode = value.children ? "40000" : value.mode;
                const id = value.children ? await build(value) : value.id;
                chunks.push(Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex"));
            }
            return this.object("tree", Buffer.concat(chunks));
        };
        return build(tree);
    }

    async metadata() {
        let info;
        try { info = await lstat(this.statePath); } catch (error) {
            if (error.code === "ENOENT") return { schema: 1, root: this.root, checkpoint: null, feedback: [], feedbackVersion: 0 };
            throw error;
        }
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) fail("invalid_review_state", "Review metadata is not a supported local file.");
        let value;
        try { value = JSON.parse(await readFile(this.statePath, "utf8")); }
        catch (error) { fail("invalid_review_state", `Cannot read persisted review metadata: ${error.message}`); }
        if (value.schema !== 1 || value.root !== this.root || !Array.isArray(value.feedback) ||
            !Number.isSafeInteger(value.feedbackVersion) || value.feedbackVersion < 0 ||
            value.feedback.length > this.limits.feedback ||
            (value.checkpoint && (!SHA.test(value.checkpoint.tree) || typeof value.checkpoint.id !== "string" ||
                !Number.isFinite(Date.parse(value.checkpoint.at))))) {
            fail("invalid_review_state", "Stored review metadata does not match this repository.");
        }
        for (const note of value.feedback) {
            if (!note.id || typeof note.text !== "string" || note.text.length > 2000 ||
                !["open", "resolved"].includes(note.status) || (note.anchor !== null && typeof note.anchor !== "string")) {
                fail("invalid_review_state", "A stored feedback entry is invalid.");
            }
            relativeName(note.path);
        }
        return value;
    }

    async writeMetadata(action) {
        const lock = path.join(this.directory, "write.lock");
        let handle;
        try { handle = await open(lock, "wx", 0o600); } catch (error) {
            if (error.code !== "EEXIST") throw error;
            fail("review_busy", `Review metadata is being updated. Retry shortly. If an extension crashed, remove only this stale lock: ${lock}`);
        }
        const temp = path.join(this.directory, `review-${randomUUID()}.tmp`);
        try {
            const state = await this.metadata();
            await action(state);
            await writeFile(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
            await rename(temp, this.statePath);
        } finally {
            await handle.close();
            await unlink(lock);
            try { await unlink(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
    }

    async baselineFiles(tree) {
        if (!tree) return new Map();
        if (this.treeFiles.has(tree)) return this.treeFiles.get(tree);
        const records = (await this.git(["ls-tree", "-rz", tree])).split("\0").filter(Boolean);
        const files = new Map(records.map((record) => {
            const tab = record.indexOf("\t");
            const [mode, , id] = record.slice(0, tab).split(" ");
            return [record.slice(tab + 1), { id, mode }];
        }));
        this.treeFiles.clear();
        this.treeFiles.set(tree, files);
        return files;
    }

    async readState() {
        const metadata = await this.metadata();
        const current = await this.snapshot();
        const checkpoint = metadata.checkpoint;
        const id = hash(JSON.stringify([checkpoint?.id, current.id]));
        const files = [];
        if (checkpoint) {
            const baseArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", checkpoint.tree, current.id];
            const [names, counts] = await Promise.all([
                this.git([...baseArgs, "--name-status", "-z"]),
                this.git([...baseArgs, "--numstat", "-z"]),
            ]);
            const stats = parseNumstat(counts);
            const tokens = names.split("\0").filter(Boolean);
            for (let i = 0; i < tokens.length;) {
                const status = tokens[i++];
                const from = tokens[i++];
                const renamed = status.startsWith("R");
                const name = renamed ? tokens[i++] : from;
                const count = stats.get(name) ?? { additions: 0, deletions: 0 };
                files.push({
                    path: name, oldPath: renamed ? from : null,
                    status: ({ A: "Added", M: "Modified", D: "Deleted", T: "Type changed", R: "Renamed" })[status[0]] ?? "Modified",
                    ...count, binary: count.additions === null,
                });
            }
        }
        this.views.set(id, { checkpointId: checkpoint?.id ?? null, base: checkpoint?.tree, current, files });
        while (this.views.size > 12) this.views.delete(this.views.keys().next().value);
        const anchor = (name) => {
            const entry = current.files.get(name);
            return entry ? `${entry.mode}:${entry.id}` : null;
        };
        return {
            root: this.root,
            checkpoint: checkpoint ? { id: checkpoint.id, at: checkpoint.at, files: checkpoint.files } : null,
            viewId: id, currentTree: current.id, files,
            counts: files.reduce((total, file) => ({
                files: total.files + 1, additions: total.additions + (file.additions ?? 0), deletions: total.deletions + (file.deletions ?? 0),
            }), { files: 0, additions: 0, deletions: 0 }),
            feedback: metadata.feedback.map(({ anchor: savedAnchor, ...note }) => ({
                ...note, changedSinceComment: savedAnchor !== anchor(note.path),
            })),
            feedbackVersion: metadata.feedbackVersion,
        };
    }

    state() { return this.run(() => this.readState()); }

    view(id) {
        const value = this.views.get(id);
        if (!value) fail("stale_view", "This review view has expired. Refresh and review the latest changes.");
        return value;
    }

    diff(name, viewId) {
        return this.run(async () => {
            relativeName(name);
            const view = this.view(viewId);
            const file = view.files.find((entry) => entry.path === name);
            if (!file) fail("review_path_not_found", "This file is not part of the selected review delta.");
            const previousName = file.oldPath ?? name;
            const previous = (await this.baselineFiles(view.base)).get(previousName);
            const current = view.current.files.get(name);
            // A Git pathspec also matches descendants when a file becomes a directory.
            // Compare single-entry trees so each file view contains only that file.
            const [before, after] = await Promise.all([
                this.tree(previous ? [{ ...previous, path: previousName }] : []),
                this.tree(current ? [current] : []),
            ]);
            const diff = await this.git([
                "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--unified=3",
                before, after,
            ]);
            return { path: name, diff, empty: !diff.trim(), binary: file.binary };
        });
    }

    markReviewed(viewId) {
        return this.run(async () => {
            const visible = this.view(viewId);
            const current = await this.snapshot();
            if (current.id !== visible.current.id) fail("stale_view", "Files changed since this view loaded. Refresh and review them before marking reviewed.");
            await this.writeMetadata(async (metadata) => {
                if ((metadata.checkpoint?.id ?? null) !== visible.checkpointId) fail("stale_view", "Another panel updated the review checkpoint. Refresh first.");
                metadata.checkpoint = { id: randomUUID(), tree: current.id, at: new Date().toISOString(), files: current.count };
            });
            return this.readState();
        });
    }

    addFeedback({ viewId, path: name, text }) {
        return this.run(async () => {
            relativeName(name);
            if (typeof text !== "string" || !text.trim() || text.length > 2000) fail("invalid_feedback", "Feedback must contain 1 to 2,000 characters.");
            const view = this.view(viewId);
            const before = await this.baselineFiles(view.base);
            if (!view.current.files.has(name) && !before.has(name)) fail("review_path_not_found", "Feedback must refer to a file in this review.");
            const entry = view.current.files.get(name);
            await this.writeMetadata(async (metadata) => {
                if ((metadata.checkpoint?.id ?? null) !== view.checkpointId) fail("stale_view", "The review checkpoint changed. Refresh before adding feedback.");
                if (metadata.feedback.length >= this.limits.feedback) fail("feedback_limit", "The local feedback limit has been reached.");
                metadata.feedback.push({
                    id: randomUUID(), path: name, text: text.trim(), status: "open",
                    createdAt: new Date().toISOString(), resolvedAt: null,
                    anchor: entry ? `${entry.mode}:${entry.id}` : null,
                });
                metadata.feedbackVersion++;
            });
            return this.readState();
        });
    }

    setFeedback({ id, status, feedbackVersion }) {
        return this.run(async () => {
            if (!["open", "resolved"].includes(status)) fail("invalid_feedback", "Choose open or resolved.");
            await this.writeMetadata(async (metadata) => {
                if (metadata.feedbackVersion !== feedbackVersion) fail("stale_feedback", "Feedback changed in another panel. Refresh before updating.");
                const note = metadata.feedback.find((entry) => entry.id === id);
                if (!note) fail("feedback_not_found", "This feedback entry no longer exists.");
                note.status = status;
                note.resolvedAt = status === "resolved" ? new Date().toISOString() : null;
                metadata.feedbackVersion++;
            });
            return this.readState();
        });
    }
}
