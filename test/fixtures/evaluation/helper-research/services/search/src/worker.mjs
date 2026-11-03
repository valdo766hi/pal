import { environment } from "./env.mjs";
import { queueName } from "./queue.mjs";

export const queue = queueName(environment);
