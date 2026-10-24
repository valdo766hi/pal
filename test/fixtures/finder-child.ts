import { NativeFinder } from "../../src/core/native-finder.ts";

const root = process.argv[2];
if (root === undefined) throw new Error("missing native finder fixture root");
const opened = await NativeFinder.open({ basePath: root, disableContentIndexing: true, disableMmapCache: true }, 8000);
if (!opened.ok) throw new Error(opened.error);
const finder = opened.value;
const scanned = await finder.waitForScan(10_000);
if (!scanned.ok || !scanned.value) throw new Error("fixture scan did not complete");
const found = await finder.grep("needle", { mode: "plain", pageSize: 10 });
if (!found.ok || found.value.items.length !== 1) throw new Error("fixture native search failed");
process.send?.({ group: finder.pid, worker: finder.workerPid });
setInterval(() => {}, 1000);
