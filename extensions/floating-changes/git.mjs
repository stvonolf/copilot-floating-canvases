import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const MAX_UNTRACKED_PREVIEW = 1024 * 1024;
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export class GitError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

async function git(cwd, args, { allow = [] } = {}) {
    try {
        const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
            cwd,
            encoding: "utf8",
            maxBuffer: MAX_GIT_OUTPUT,
            windowsHide: true,
        });
        return stdout;
    } catch (error) {
        if (allow.includes(error.code)) return error.stdout ?? "";
        const message = String(error.stderr || error.message || error).trim();
        throw new GitError("git_failed", message || `git ${args.join(" ")} failed`);
    }
}

export async function resolveRepository(cwd) {
    if (!cwd || typeof cwd !== "string") throw new GitError("cwd_required", "A working directory is required.");
    const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (!root) throw new GitError("not_a_repository", `${cwd} is not inside a Git repository.`);
    return path.resolve(root);
}

function parseCount(value) {
    return value === "-" ? null : Number.parseInt(value, 10) || 0;
}

export function parseNumstat(output) {
    const stats = new Map();
    const tokens = output.split("\0");
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token) continue;
        const first = token.indexOf("\t");
        const second = token.indexOf("\t", first + 1);
        if (first < 0 || second < 0) continue;

        const additions = parseCount(token.slice(0, first));
        const deletions = parseCount(token.slice(first + 1, second));
        let filePath = token.slice(second + 1);

        // With -z, rename/copy records leave the path field empty, followed by
        // the old and new names as separate NUL-delimited tokens.
        if (!filePath) {
            i++; // old path
            filePath = tokens[++i] ?? "";
        }
        if (filePath) stats.set(filePath, { additions, deletions });
    }
    return stats;
}

function statusLabel(code, kind) {
    if (kind === "untracked") return "Untracked";
    if (kind === "conflict") return "Conflict";
    return (
        {
            M: "Modified",
            A: "Added",
            D: "Deleted",
            R: "Renamed",
            C: "Copied",
            T: "Type changed",
            U: "Unmerged",
        }[code] ?? "Changed"
    );
}

export function parsePorcelain(output) {
    const groups = { conflicts: [], staged: [], working: [], untracked: [] };
    const records = output.split("\0");

    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record || record.length < 3) continue;

        const x = record[0];
        const y = record[1];
        const xy = `${x}${y}`;
        const filePath = record.slice(3);
        let oldPath = null;
        if (x === "R" || x === "C" || y === "R" || y === "C") oldPath = records[++i] ?? null;

        const base = { path: filePath, oldPath, xy };
        if (CONFLICT_CODES.has(xy)) {
            groups.conflicts.push({ ...base, kind: "conflict", status: statusLabel("U", "conflict") });
        } else if (xy === "??") {
            groups.untracked.push({ ...base, kind: "untracked", status: statusLabel("?", "untracked") });
        } else {
            if (x !== " " && x !== "?") {
                groups.staged.push({ ...base, kind: "staged", status: statusLabel(x, "staged") });
            }
            if (y !== " " && y !== "?") {
                groups.working.push({ ...base, kind: "working", status: statusLabel(y, "working") });
            }
        }
    }

    for (const entries of Object.values(groups)) entries.sort((a, b) => a.path.localeCompare(b.path));
    return groups;
}

function applyStats(entries, stats) {
    return entries.map((entry) => ({ ...entry, ...(stats.get(entry.path) ?? { additions: null, deletions: null }) }));
}

async function branchInfo(root) {
    let branch = (await git(root, ["branch", "--show-current"])).trim();
    if (!branch) branch = `detached@${(await git(root, ["rev-parse", "--short", "HEAD"])).trim()}`;

    const upstream = (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allow: [128] })).trim();
    let ahead = 0;
    let behind = 0;
    if (upstream) {
        const counts = (await git(root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).trim();
        [ahead, behind] = counts.split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
    }
    return { branch, upstream: upstream || null, ahead, behind };
}

function sumStats(entries) {
    return entries.reduce(
        (total, entry) => {
            if (typeof entry.additions === "number") total.additions += entry.additions;
            if (typeof entry.deletions === "number") total.deletions += entry.deletions;
            return total;
        },
        { additions: 0, deletions: 0 },
    );
}

export async function readChanges(root) {
    const [porcelain, workingNumstat, stagedNumstat, branch] = await Promise.all([
        git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        git(root, ["diff", "--no-ext-diff", "--numstat", "-z"]),
        git(root, ["diff", "--cached", "--no-ext-diff", "--numstat", "-z"]),
        branchInfo(root),
    ]);

    const parsed = parsePorcelain(porcelain);
    const workingStats = parseNumstat(workingNumstat);
    const stagedStats = parseNumstat(stagedNumstat);
    const groups = {
        conflicts: applyStats(parsed.conflicts, workingStats),
        staged: applyStats(parsed.staged, stagedStats),
        working: applyStats(parsed.working, workingStats),
        untracked: parsed.untracked.map((entry) => ({ ...entry, additions: null, deletions: null })),
    };
    const entries = Object.values(groups).flat();
    const uniqueFiles = new Set(entries.map((entry) => entry.path));

    return {
        root,
        repository: path.basename(root),
        ...branch,
        groups,
        totals: { files: uniqueFiles.size, entries: entries.length, ...sumStats(entries) },
        clean: entries.length === 0,
        refreshedAt: new Date().toISOString(),
    };
}

function safeRelativePath(root, filePath) {
    if (!filePath || typeof filePath !== "string" || filePath.includes("\0")) {
        throw new GitError("path_required", "A file path is required.");
    }
    const resolved = path.resolve(root, filePath);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new GitError("path_outside_repository", "The file must be inside the repository.");
    }
    return relative.replaceAll("\\", "/");
}

async function untrackedDiff(root, filePath) {
    const absolute = path.join(root, filePath);
    const info = await stat(absolute);
    if (!info.isFile()) return `Untracked path is not a regular file: ${filePath}\n`;
    if (info.size > MAX_UNTRACKED_PREVIEW) {
        return `Untracked file is too large to preview (${info.size.toLocaleString()} bytes): ${filePath}\n`;
    }
    const content = await readFile(absolute);
    if (content.includes(0)) return `Binary untracked file: ${filePath}\n`;

    const text = content.toString("utf8");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const body = lines.map((line) => `+${line}`).join("\n");
    return [
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        body,
        "",
    ].join("\n");
}

export async function readDiff(root, filePath, kind = "working") {
    const relative = safeRelativePath(root, filePath);
    let diff;
    if (kind === "staged") {
        diff = await git(root, ["diff", "--cached", "--no-ext-diff", "--unified=3", "--", relative]);
    } else if (kind === "conflict") {
        diff = await git(root, ["diff", "--no-ext-diff", "--cc", "--unified=3", "--", relative]);
    } else if (kind === "untracked") {
        diff = await untrackedDiff(root, relative);
    } else if (kind === "working") {
        diff = await git(root, ["diff", "--no-ext-diff", "--unified=3", "--", relative]);
    } else {
        throw new GitError("invalid_kind", `Unsupported diff kind: ${kind}`);
    }

    return { path: relative, kind, diff, empty: !diff.trim() };
}
