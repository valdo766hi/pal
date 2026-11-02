import { Type } from "typebox";
import type { CompiledCapabilities, CompiledCapability } from "../../src/capabilities/contract.ts";
import { HttpError } from "../../src/core/http.ts";
import { validate } from "../../src/core/requests.ts";
import manifest from "./manifest.ts";
import { MemoryBody, ProjectMemory } from "./memory.ts";

const WorkspaceId = Type.Optional(Type.String({ minLength: 1, maxLength: 64 }));
const NewMemory = Type.Object(
  { ...MemoryBody.properties, requestId: Type.Unknown(), workspace: WorkspaceId },
  { additionalProperties: false },
);
const CorrectMemory = Type.Object(
  { ...MemoryBody.properties, revision: Type.Integer({ minimum: 1 }), workspace: WorkspaceId },
  { additionalProperties: false },
);
const ForgetMemory = Type.Object(
  { revision: Type.Integer({ minimum: 1 }), workspace: WorkspaceId },
  { additionalProperties: false },
);

export default {
  manifest,
  open(host) {
    const memory = new ProjectMemory(host.sql, host.folders, host.storage, host.deny, host.privateFiles);
    return {
      service: memory,
      tools: memory.tools(host.project).tools ?? [],
      // projects/<id>/items[/<memory>[/source]] and projects/<id>/index, all owner requests.
      async api({ method, path, query, body }, context) {
        const [resource, project, part, id, detail] = path;
        const workspace = query.has("workspace") ? validate(WorkspaceId, query.get("workspace")) : undefined;
        if (resource === "projects" && project !== undefined && part === "items") {
          if (path.length === 3 && method === "GET") return { items: await memory.list(project, context, workspace) };
          if (path.length === 3 && method === "POST") {
            const { requestId, workspace, ...input } = validate(NewMemory, body);
            return { id: await memory.save(project, requestId, input, context, workspace) };
          }
          if (id !== undefined && path.length === 4 && method === "PUT") {
            const { revision, workspace, ...input } = validate(CorrectMemory, body);
            await memory.correct(project, id, revision, input, context, workspace);
            return { saved: true };
          }
          if (id !== undefined && path.length === 4 && method === "DELETE") {
            const { revision, workspace } = validate(ForgetMemory, body);
            await memory.forget(project, id, revision, workspace);
            return { forgotten: true };
          }
          if (id !== undefined && detail === "source" && path.length === 5 && method === "GET")
            return memory.source(project, id, context, workspace);
        }
        if (resource === "projects" && project !== undefined && part === "index" && path.length === 3) {
          if (method === "POST") {
            await memory.rebuild(project);
            return { rebuilt: true };
          }
        }
        throw new HttpError(404, "not_found", "no such memory operation");
      },
    };
  },
} satisfies CompiledCapability;

/** The open memory service, for trusted callers such as tests. */
export function projectMemory(capabilities: CompiledCapabilities): ProjectMemory {
  const memory = capabilities.service<ProjectMemory>("memory");
  if (memory === undefined)
    throw new HttpError(503, "capability_unavailable", "Memory is not included in this Pal build.");
  return memory;
}
