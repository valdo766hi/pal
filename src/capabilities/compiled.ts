import { memoryCapability } from "./memory.ts";

// Build-time selection only; no runtime package loader.
export const COMPILED_CAPABILITIES = [memoryCapability];
