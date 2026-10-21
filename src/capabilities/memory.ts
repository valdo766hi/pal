import { MEMORY_NAMESPACE, ProjectMemory } from "../core/memory.ts";
import type { CompiledCapability } from "./contract.ts";

export const memoryCapability = {
  manifest: {
    id: "memory",
    version: 1,
    native: "pal.memory",
    name: "Context and memory",
    description: "Source-linked memory adapter and Context panel. Core instruction/preparation hooks always stay on.",
    core: { min: 1, max: 1 },
    panels: ["Context"],
    settings: "new-chat-selection",
    namespace: MEMORY_NAMESPACE,
    tools: [{ name: "memory_search", replay: "safe", permissions: ["project.read"], maxOutputBytes: 4096 }],
  },
  open(host) {
    const memory = new ProjectMemory(host.database, host.folders, host.storage, host.deny);
    return { memory, tools: memory.tools(host.project).tools ?? [] };
  },
} satisfies CompiledCapability;
