import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { PlanError, PlanHistory } from "./history.mjs";

export const MAX_PLAN_BYTES = 1024 * 1024;
export const MAX_PLAN_LINES = 20000;
export const CAPTURE_DELAY_MS = 5000;

function fingerprint(content) {
    return content === null ? null : createHash("sha256").update(content).digest("hex");
}

export class PlanTracker {
    constructor(workspacePath, { captureDelayMs = CAPTURE_DELAY_MS, pollMs = 1000, onError = console.error } = {}) {
        if (!workspacePath || !path.isAbsolute(workspacePath)) {
            throw new PlanError("workspace_unavailable", "The runtime did not provide an absolute session workspace. Native plan tracking is unavailable.");
        }
        this.workspacePath = workspacePath;
        this.planPath = path.join(workspacePath, "plan.md");
        this.store = new PlanHistory(workspacePath);
        this.delay = captureDelayMs;
        this.pollMs = pollMs;
        this.onError = onError;
        this.current = null;
        this.saved = null;
        this.head = null;
        this.readError = null;
        this.historyError = null;
        this.dueAt = null;
        this.history = { entries: [], nextCursor: null };
        this.queue = Promise.resolve();
        this.timer = null;
        this.closed = false;
        this.ticking = false;
        this.revisionCache = new Map();
    }

    run(action) {
        const result = this.queue.then(action);
        // Keep the queue usable after failure; the original result still rejects to its caller.
        this.queue = result.catch(() => {});
        return result;
    }

    async start() {
        this.workspacePath = await realpath(this.workspacePath);
        this.planPath = path.join(this.workspacePath, "plan.md");
        await this.store.initialize();
        await this.loadHistory();
        await this.refresh();
        this.timer = setInterval(() => {
            if (this.closed || this.ticking) return;
            this.ticking = true;
            void this.run(async () => {
                await this.readCurrent();
                if (!this.readError && this.dueAt !== null && Date.now() >= this.dueAt) await this.save();
            }).catch((error) => this.report(error)).finally(() => { this.ticking = false; });
        }, this.pollMs);
        this.timer.unref();
        return this;
    }

    get error() {
        return this.readError ?? this.historyError;
    }

    report(error, source = "history") {
        const next = { code: error.code ?? "tracking_failed", message: String(error.message ?? error) };
        if (this.error?.code !== next.code || this.error?.message !== next.message) this.onError(error);
        if (source === "read") this.readError = next;
        else this.historyError = next;
        this.dueAt = null;
    }

    async loadHistory() {
        this.history = await this.store.list();
        this.head = this.history.entries[0]?.id ?? null;
        this.saved = this.head ? await this.store.content(this.head) : null;
        this.revisionCache.clear();
    }

    async readCurrent() {
        let content = null;
        try {
            const info = await lstat(this.planPath);
            if (!info.isFile() || info.isSymbolicLink()) {
                throw new PlanError("unsafe_plan", "The native plan must be a regular file, not a directory or symbolic link.");
            }
            if (info.size > MAX_PLAN_BYTES) throw new PlanError("plan_too_large", "The plan exceeds the 1 MiB preview limit.");
            const handle = await open(this.planPath, "r");
            try {
                const actualPath = await realpath(this.planPath);
                if (actualPath !== this.planPath) throw new PlanError("unsafe_plan", "The plan path resolves outside its expected native location.");
                const before = await handle.stat();
                if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev) {
                    throw new PlanError("plan_changing", "The plan was replaced while being read. Retrying.");
                }
                if (before.size > MAX_PLAN_BYTES) throw new PlanError("plan_too_large", "The plan exceeds the 1 MiB preview limit.");
                const buffer = Buffer.alloc(MAX_PLAN_BYTES + 1);
                let bytesRead = 0;
                while (bytesRead < buffer.length) {
                    const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                    if (!read.bytesRead) break;
                    bytesRead += read.bytesRead;
                }
                const after = await handle.stat();
                const currentPath = await lstat(this.planPath);
                if (bytesRead > MAX_PLAN_BYTES) throw new PlanError("plan_too_large", "The plan exceeds the 1 MiB preview limit.");
                if (currentPath.isSymbolicLink() || currentPath.ino !== after.ino || currentPath.dev !== after.dev ||
                    before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== after.size) {
                    throw new PlanError("plan_changing", "The plan is being written. Waiting for a complete version.");
                }
                if (buffer.subarray(0, bytesRead).includes(0)) throw new PlanError("invalid_plan", "The plan contains binary data.");
                try {
                    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
                } catch (error) {
                    if (!(error instanceof TypeError)) throw error;
                    throw new PlanError("invalid_plan", "The plan is not valid UTF-8 text.");
                }
                if (content.split("\n").length > MAX_PLAN_LINES) {
                    throw new PlanError("plan_too_large", "The plan exceeds the 20,000-line preview limit.");
                }
            } finally {
                await handle.close();
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.report(error, "read");
                return;
            }
        }
        const wasError = this.readError !== null;
        this.readError = null;
        if (content !== this.current || wasError) {
            this.current = content;
            this.revisionCache.delete("working");
            this.dueAt = content !== null && content !== this.saved ? Date.now() + this.delay : null;
        } else if (content !== null && content !== this.saved && this.dueAt === null) {
            this.dueAt = Date.now() + this.delay;
        }
    }

    async save() {
        if (this.readError) throw new PlanError(this.readError.code, this.readError.message);
        if (this.current === null) throw new PlanError("plan_missing", "There is no native plan file to capture.");
        await this.store.capture(this.current);
        await this.loadHistory();
        this.historyError = null;
        this.dueAt = null;
    }

    state() {
        const status = this.error ? "error" : this.current !== null ? "ready" : this.head ? "missing" : "waiting";
        const titleSource = this.current ?? this.saved ?? "";
        const title = /^#\s+(.+)$/m.exec(titleSource.replace(/^\uFEFF/, ""))?.[1]?.trim().slice(0, 150) || "Native plan";
        return {
            planPath: this.planPath,
            title,
            status,
            current: { exists: this.current !== null, digest: fingerprint(this.current), bytes: Buffer.byteLength(this.current ?? "") },
            working: this.current !== this.saved,
            head: this.head,
            version: fingerprint(JSON.stringify([fingerprint(this.current), this.head, this.error, this.dueAt])),
            capture: { delayMs: this.delay, dueAt: this.dueAt === null ? null : new Date(this.dueAt).toISOString() },
            error: this.error,
            history: this.history,
        };
    }

    refresh() {
        return this.run(async () => {
            await this.readCurrent();
            return this.state();
        });
    }

    capture() {
        return this.run(async () => {
            await this.readCurrent();
            try {
                await this.save();
            } catch (error) {
                if (!this.readError) this.report(error);
                throw error;
            }
            return this.state();
        });
    }

    list(before = null) {
        return this.run(() => this.store.list(before));
    }

    revision(id = "working") {
        return this.run(async () => {
            await this.readCurrent();
            if (id !== "working") {
                if (!this.revisionCache.has(id)) this.revisionCache.set(id, await this.store.revision(id));
                return { ...this.revisionCache.get(id), isLatest: id === this.head };
            }
            if (this.error) throw new PlanError(this.error.code, this.error.message);
            if (!this.revisionCache.has("working")) {
                this.revisionCache.set("working", {
                    id: "working", title: "Working changes", createdAt: null, parent: this.head,
                    content: this.current ?? "", exists: this.current !== null,
                    isWorking: true, isLatest: true,
                    diff: await this.store.diff(this.saved ?? "", this.current ?? ""),
                });
            }
            return this.revisionCache.get("working");
        });
    }

    async dispose() {
        this.closed = true;
        if (this.timer) clearInterval(this.timer);
        await this.queue;
        this.revisionCache.clear();
    }
}
