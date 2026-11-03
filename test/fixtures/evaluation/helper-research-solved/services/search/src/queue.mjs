export function queueName({ prefix = "prod", shard = 0 } = {}) {
  return `${prefix}-search-${shard}`;
}
