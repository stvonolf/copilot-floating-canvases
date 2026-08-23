// Boots the extension's loopback server in-process and prints its port.
// The suite spawns this with a working directory chosen to control the shell
// prompt's length, which is what determines line wrapping.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const { ensureServer } = await import(`file:///${path.join(root, "server.mjs").replace(/\\/g, "/")}`);
const { environmentProblem } = await import(`file:///${path.join(root, "terminals.mjs").replace(/\\/g, "/")}`);

const problem = await environmentProblem();
const { port } = await ensureServer();
console.log(`PORT=${port}`);
console.log(`ENV=${problem ? `unsupported: ${problem.split("\n")[0]}` : "ok"}`);
