import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REVISION = /^[a-f0-9]{40}$/;
const ZERO = "0".repeat(40);
const MAX_OUTPUT = 8 * 1024 * 1024;
// Git for Windows does not accept Node's "\\\\.\\nul" device path as a config file.
const GIT_NULL = process.platform === "win32" ? "NUL" : os.devNull;

export class PlanError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function gitEnvironment() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    return {
        ...env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: GIT_NULL,
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Plan Time Machine",
        GIT_AUTHOR_EMAIL: "plan-time-machine@localhost",
        GIT_COMMITTER_NAME: "Plan Time Machine",
        GIT_COMMITTER_EMAIL: "plan-time-machine@localhost",
    };
}

async function directory(parent, name) {
    const target = path.join(parent, name);
    try {
        await mkdir(target, { mode: 0o700 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new PlanError("unsafe_storage", `History storage must be a regular directory: ${target}`);
    }
    return target;
}

export function parseDiff(patch) {
    const lines = [];
    let oldLine = 0;
    let newLine = 0;
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const text of patch.split("\n")) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
        if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            inHunk = true;
            lines.push({ type: "hunk", oldLine, newLine, text });
        } else if (inHunk && text.startsWith("+")) {
            lines.push({ type: "add", oldLine: null, newLine: newLine++, text: text.slice(1) });
            added++;
        } else if (inHunk && text.startsWith("-")) {
            lines.push({ type: "remove", oldLine: oldLine++, newLine: null, text: text.slice(1) });
            removed++;
        } else if (inHunk && text.startsWith(" ")) {
            lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, text: text.slice(1) });
        } else if (inHunk && text.startsWith("\\")) {
            lines.push({ type: "notice", oldLine: null, newLine: null, text });
        }
    }
    return { lines, added, removed };
}

function titleFor(diff, before, after) {
    function sections(content) {
        let label = null;
        return content.split(/\r?\n/).map((line) => {
            const heading = /^#{1,6}\s+(.+)/.exec(line);
            if (heading) label = heading[1].replace(/[\t\r\n\x00-\x1f]/g, " ").trim().slice(0, 50);
            return label;
        });
    }
    const oldSections = sections(before);
    const newSections = sections(after);
    const headings = new Set();
    for (const change of diff.lines) {
        if (change.type !== "add" && change.type !== "remove") continue;
        const source = change.type === "add" ? newSections : oldSections;
        const index = (change.type === "add" ? change.newLine : change.oldLine) - 1;
        if (source[index]) headings.add(source[index]);
        if (headings.size >= 3) break;
    }
    return headings.size ? `Update ${[...headings].join(", ")}`.slice(0, 150) : "Update plan";
}

export class PlanHistory {
    constructor(workspacePath) {
        this.workspacePath = workspacePath;
        this.repo = null;
    }

    async initialize() {
        const workspace = await realpath(this.workspacePath);
        const files = await directory(workspace, "files");
        const storage = await directory(files, "plan-time-machine");
        this.repo = await directory(storage, "history.git");
        let initialized = false;
        try {
            const info = await lstat(path.join(this.repo, "HEAD"));
            if (!info.isFile() || info.isSymbolicLink()) throw new PlanError("unsafe_storage", "Invalid history HEAD.");
            initialized = true;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (!initialized) {
            await this.git(["init", "--bare", "--template=", "--initial-branch=main", "--object-format=sha1"]);
        }
        const bare = (await this.git(["rev-parse", "--is-bare-repository"])).trim();
        if (bare !== "true") throw new PlanError("invalid_history", "Plan history is not a dedicated bare Git repository.");
    }

    async git(args, { input, allowCodes = [] } = {}) {
        if (!this.repo) throw new PlanError("history_not_ready", "Plan history has not been initialized.");
        const command = exec("git", [
            `--git-dir=${this.repo}`,
            "-c", "core.quotepath=false",
            "-c", `core.attributesFile=${GIT_NULL}`,
            "-c", `core.hooksPath=${path.join(this.repo, "disabled-hooks")}`,
            "-c", "commit.gpgSign=false",
            ...args,
        ], {
            cwd: this.workspacePath,
            env: gitEnvironment(),
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: MAX_OUTPUT,
            windowsHide: true,
        });
        command.child.stdin.on("error", (error) => {
            if (error.code !== "EPIPE") command.child.kill();
        });
        command.child.stdin.end(input ?? "");
        try {
            return (await command).stdout;
        } catch (error) {
            if (allowCodes.includes(error.code)) return error.stdout ?? "";
            const message = String(error.stderr || error.message || error).trim();
            const failure = new PlanError("git_failed", message || "Git could not read or save plan history.");
            failure.exitCode = error.code;
            throw failure;
        }
    }

    async head() {
        return (await this.git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], { allowCodes: [1] })).trim() || null;
    }

    async requireRevision(id) {
        if (!REVISION.test(id ?? "")) throw new PlanError("invalid_revision", "Choose a saved plan revision.");
        if (!(await this.head())) throw new PlanError("revision_not_found", "No plan revisions have been saved.");
        let ancestor;
        try {
            ancestor = (await this.git(["merge-base", id, "refs/heads/main"], { allowCodes: [1] })).trim();
        } catch (error) {
            if (error.exitCode !== 128) throw error;
            throw new PlanError("revision_not_found", "That revision is not in this plan's history.");
        }
        if (ancestor !== id) throw new PlanError("revision_not_found", "That revision is not in this plan's history.");
        return id;
    }

    async content(id) {
        return this.git(["show", `${id}:plan.md`]);
    }

    async blob(content) {
        return (await this.git(["hash-object", "-w", "--stdin"], { input: content })).trim();
    }

    async diff(before, after) {
        if (before === after) return { lines: [], added: 0, removed: 0 };
        const oldBlob = await this.blob(before);
        const newBlob = await this.blob(after);
        const patch = await this.git([
            "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--text",
            "--unified=3", oldBlob, newBlob,
        ]);
        return parseDiff(patch);
    }

    async capture(content) {
        const blob = await this.blob(content);
        for (let attempt = 0; attempt < 4; attempt++) {
            const head = await this.head();
            const before = head ? await this.content(head) : "";
            if (head && before === content) return head;
            const tree = (await this.git(["mktree"], { input: `100644 blob ${blob}\tplan.md\n` })).trim();
            const title = head ? titleFor(await this.diff(before, content), before, content) : "Initial plan";
            const commit = (await this.git(["commit-tree", tree, ...(head ? ["-p", head] : [])], {
                input: `${title}\n`,
            })).trim();
            try {
                await this.git(["update-ref", "refs/heads/main", commit, head ?? ZERO]);
                return commit;
            } catch (error) {
                // Another provider may have captured while this provider was reconnecting.
                if (await this.head() === head) throw error;
            }
        }
        throw new PlanError("history_busy", "Another provider is saving plan history. Retry shortly.");
    }

    async list(before = null, limit = 50) {
        let start = await this.head();
        if (!start) return { entries: [], nextCursor: null };
        if (before) {
            await this.requireRevision(before);
            const parents = (await this.git(["show", "-s", "--format=%P", before])).trim();
            if (!parents) return { entries: [], nextCursor: null };
            start = parents.split(" ")[0];
        }
        const output = await this.git(["log", `--max-count=${limit + 1}`, "--format=%H%x09%P%x09%ct%x09%s", start]);
        const all = output.trimEnd().split("\n").filter(Boolean).map((line) => {
            const [id, parent, timestamp, ...subject] = line.split("\t");
            return {
                id, shortId: id.slice(0, 7), parent: parent || null,
                createdAt: new Date(Number(timestamp) * 1000).toISOString(),
                title: subject.join(" "),
            };
        });
        const entries = all.slice(0, limit);
        return { entries, nextCursor: all.length > limit ? entries.at(-1).id : null };
    }

    async revision(id) {
        await this.requireRevision(id);
        const output = (await this.git(["show", "-s", "--format=%P%x09%ct%x09%s", id])).trimEnd();
        const [parent, timestamp, ...subject] = output.split("\t");
        const content = await this.content(id);
        return {
            id, title: subject.join(" "), parent: parent || null,
            createdAt: new Date(Number(timestamp) * 1000).toISOString(),
            content, exists: true, isWorking: false, isLatest: id === await this.head(),
            diff: await this.diff(parent ? await this.content(parent) : "", content),
        };
    }
}
