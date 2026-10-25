import { HostCommands } from "../../src/core/execution.ts";

const cwd = process.argv[2];
if (cwd === undefined) throw new Error("missing fixture directory");
const rewriteMs = process.argv[3];
const commands = new HostCommands(rewriteMs === undefined ? {} : { rewriteMs: Number(rewriteMs) });
await commands.rewrite(cwd, "slow orphan");
