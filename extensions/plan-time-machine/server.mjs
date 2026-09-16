import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlanError } from "./history.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
    ["/", ["ui/index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["ui/app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["ui/styles.css", "text/css; charset=utf-8"]],
    ["/vendor/marked.js", ["node_modules/marked/lib/marked.umd.js", "text/javascript; charset=utf-8"]],
    ["/vendor/purify.js", ["node_modules/dompurify/dist/purify.min.js", "text/javascript; charset=utf-8"]],
]);

function json(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
}

function fail(response, status, code, message) {
    json(response, status, { error: { code, message } });
}

export async function createPlanServer(tracker, { onError = console.error } = {}) {
    const token = randomBytes(32).toString("hex");
    let origin;
    let host;
    const server = createServer(async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'");
        if (request.headers.host !== host) return fail(response, 403, "invalid_host", "This endpoint is only available on its canonical loopback address.");
        if (request.headers.origin && request.headers.origin !== origin) return fail(response, 403, "invalid_origin", "Cross-origin requests are not permitted.");
        if (!request.url?.startsWith("/") || request.url.startsWith("//")) return fail(response, 400, "invalid_url", "Invalid request URL.");
        let url;
        try {
            url = new URL(request.url, origin);
            if (url.origin !== origin) return fail(response, 400, "invalid_url", "Invalid request URL.");
        } catch {
            return fail(response, 400, "invalid_url", "Invalid request URL.");
        }
        const asset = assets.get(url.pathname);
        if (asset) {
            if (request.method !== "GET") return fail(response, 405, "method_not_allowed", "Use GET to load the canvas.");
            try {
                const body = await readFile(path.join(here, ...asset[0].split("/")));
                response.writeHead(200, { "Content-Type": asset[1] });
                response.end(body);
            } catch (error) {
                onError(error);
                fail(response, 500, "asset_missing", "A renderer asset is missing. Run npm ci in the installed plan-time-machine extension directory.");
            }
            return;
        }
        const supplied = request.headers["x-plan-token"];
        if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied) ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
            return fail(response, 401, "unauthorized", "This canvas connection is no longer authorized. Reopen Plan Time Machine.");
        }
        try {
            if (url.pathname === "/api/state" && request.method === "GET") return json(response, 200, await tracker.refresh());
            if (url.pathname === "/api/history" && request.method === "GET") {
                return json(response, 200, await tracker.list(url.searchParams.get("before")));
            }
            if (url.pathname === "/api/revision" && request.method === "GET") {
                const id = url.searchParams.get("id") ?? "working";
                if (id !== "working" && !/^[a-f0-9]{40}$/.test(id)) throw new PlanError("invalid_revision", "Choose working changes or a saved revision.");
                return json(response, 200, await tracker.revision(id));
            }
            if (url.pathname === "/api/capture" && request.method === "POST") {
                if (request.headers.origin !== origin) return fail(response, 403, "invalid_origin", "Capturing a revision requires a same-origin request.");
                if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0) > 0) {
                    return fail(response, 400, "unexpected_body", "Capture does not accept a request body.");
                }
                return json(response, 200, await tracker.capture());
            }
            fail(response, url.pathname.startsWith("/api/") ? 405 : 404, "not_found", "This operation is not available.");
        } catch (error) {
            onError(error);
            const code = error instanceof PlanError ? error.code : "internal_error";
            const status = code === "revision_not_found" ? 404 : error instanceof PlanError ? 400 : 500;
            fail(response, status, code, String(error.message ?? error));
        }
    });
    server.requestTimeout = 20000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    host = `127.0.0.1:${server.address().port}`;
    origin = `http://${host}`;
    server.on("error", onError);
    return {
        origin, token, url: `${origin}/#token=${token}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeIdleConnections();
        }),
    };
}
