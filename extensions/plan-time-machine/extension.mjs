import process from "node:process";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { PlanTracker } from "./tracker.mjs";
import { createPlanServer } from "./server.mjs";

const instances = new Set();
let tracker = null;
let serverPromise = null;
let initializationError = null;
const logError = (error) => process.stderr.write(`[plan-time-machine] ${error.code ?? "error"}: ${error.message ?? error}\n`);
const noInput = { type: "object", properties: {}, additionalProperties: false };

async function invoke(action) {
    try {
        await initialized;
        if (initializationError) throw initializationError;
        return await action(tracker);
    } catch (error) {
        throw new CanvasError(error.code ?? "plan_tracking_failed", String(error.message ?? error));
    }
}

const canvas = createCanvas({
    id: "plan-time-machine",
    displayName: "Plan Time Machine",
    description: "Read native plan history, compare revisions and working changes in a compact side panel.",
    inputSchema: noInput,
    actions: [
        {
            name: "get_status",
            description: "Read native plan availability, pending changes, and the newest history page.",
            inputSchema: noInput,
            handler: () => invoke((current) => current.refresh()),
        },
        {
            name: "get_revision",
            description: "Read an exact plan snapshot and its diff from its parent, or live working changes.",
            inputSchema: {
                type: "object", properties: { id: { type: "string", pattern: "^(working|[a-f0-9]{40})$" } },
                required: ["id"], additionalProperties: false,
            },
            handler: (ctx) => invoke((current) => current.revision(ctx.input.id)),
        },
        {
            name: "get_history",
            description: "Read a history page, optionally before a saved revision.",
            inputSchema: {
                type: "object", properties: { before: { type: "string", pattern: "^[a-f0-9]{40}$" } },
                additionalProperties: false,
            },
            handler: (ctx) => invoke((current) => current.list(ctx.input?.before)),
        },
        {
            name: "capture_revision",
            description: "Capture the current plan in local history now, without modifying the native plan or the code repository.",
            inputSchema: noInput,
            handler: () => invoke((current) => current.capture()),
        },
    ],
    open: async (ctx) => invoke(async () => {
        instances.add(ctx.instanceId);
        try {
            if (!serverPromise) {
                serverPromise = createPlanServer(tracker, { onError: logError }).catch((error) => {
                    serverPromise = null;
                    throw error;
                });
            }
            const server = await serverPromise;
            return { title: "Plan Time Machine", status: tracker.planPath, url: server.url };
        } catch (error) {
            instances.delete(ctx.instanceId);
            throw error;
        }
    }),
    onClose: async (ctx) => {
        instances.delete(ctx.instanceId);
        if (!instances.size && serverPromise) {
            const closing = serverPromise;
            serverPromise = null;
            await (await closing).close();
        }
    },
});

const initialized = joinSession({ canvases: [canvas] }).then(async (session) => {
    try {
        tracker = new PlanTracker(session.workspacePath, { onError: logError });
        await tracker.start();
    } catch (error) {
        initializationError = error;
        logError(error);
    }
});

let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            await initialized;
            const closing = serverPromise ? (await serverPromise).close() : Promise.resolve();
            await tracker?.dispose();
            await closing;
            process.exit(0);
        } catch (error) {
            logError(error);
            process.exit(1);
        }
    });
}
await initialized;
