import process from "node:process";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { GitError, readDiff } from "./git.mjs";
import {
    attachWorkspace,
    detachWorkspace,
    disposeWorkspaces,
    ensureServer,
    registerWorkspace,
    releaseWorkspace,
    retainWorkspace,
    workspaceState,
} from "./server.mjs";

const instances = new Map();

function canvasError(error) {
    if (error instanceof CanvasError) return error;
    if (error instanceof GitError) return new CanvasError(error.code, error.message);
    return new CanvasError("changes_failed", String(error.message ?? error));
}

function workspaceFor(instanceId) {
    const workspace = instances.get(instanceId);
    if (!workspace) throw new CanvasError("workspace_not_open", "Open the Changes canvas before using this action.");
    return workspace;
}

const changesCanvas = createCanvas({
    id: "floating-changes",
    displayName: "Floating changes",
    description: "A read-only Git changes panel with file diffs that can pop out into its own OS window.",
    inputSchema: {
        type: "object",
        properties: {
            cwd: {
                type: "string",
                description: "A path inside the Git repository. Defaults to the session working directory.",
            },
            detached: {
                type: "boolean",
                description: "Open directly in a floating window.",
            },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "get_status",
            description: "Read the current staged, unstaged, untracked, and conflicted files.",
            handler: async (ctx) => {
                try {
                    return await workspaceState(workspaceFor(ctx.instanceId));
                } catch (error) {
                    throw canvasError(error);
                }
            },
        },
        {
            name: "get_diff",
            description: "Read the unified diff for one changed file.",
            inputSchema: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Repository-relative file path." },
                    kind: {
                        type: "string",
                        enum: ["working", "staged", "untracked", "conflict"],
                        description: "Which version of the change to show.",
                    },
                },
                required: ["path", "kind"],
                additionalProperties: false,
            },
            handler: async (ctx) => {
                try {
                    const workspace = workspaceFor(ctx.instanceId);
                    return await readDiff(workspace.root, ctx.input.path, ctx.input.kind);
                } catch (error) {
                    throw canvasError(error);
                }
            },
        },
        {
            name: "detach",
            description: "Move the Changes panel into a floating OS window.",
            handler: async (ctx) => {
                try {
                    const { origin } = await ensureServer();
                    return await detachWorkspace(workspaceFor(ctx.instanceId), origin);
                } catch (error) {
                    throw canvasError(error);
                }
            },
        },
        {
            name: "attach",
            description: "Close the floating window and bring Changes back into the panel.",
            handler: async (ctx) => await attachWorkspace(workspaceFor(ctx.instanceId)),
        },
    ],
    open: async (ctx) => {
        try {
            const cwd = ctx.input?.cwd ?? ctx.session?.workingDirectory;
            const workspace = await registerWorkspace(cwd);
            const { origin } = await ensureServer();
            const previous = instances.get(ctx.instanceId);
            if (previous !== workspace) {
                if (previous) releaseWorkspace(previous);
                retainWorkspace(workspace);
            }
            instances.set(ctx.instanceId, workspace);

            if (ctx.input?.detached && !workspace.windowProcess) await detachWorkspace(workspace, origin);

            return {
                title: "Changes",
                status: workspace.root,
                url: `${origin}/?w=${encodeURIComponent(workspace.token)}&mode=panel`,
            };
        } catch (error) {
            throw canvasError(error);
        }
    },
    onClose: (ctx) => {
        const workspace = instances.get(ctx.instanceId);
        instances.delete(ctx.instanceId);
        if (workspace) releaseWorkspace(workspace);
    },
});

const session = await joinSession({ canvases: [changesCanvas] });
const { port } = await ensureServer();
try {
    await session.log(`floating-changes ready on 127.0.0.1:${port}`, { level: "info", ephemeral: true });
} catch {
    // A diagnostic must never take down the extension.
}

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
        await disposeWorkspaces();
        process.exit(0);
    });
}
