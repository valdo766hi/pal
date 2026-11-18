# Rename timeoutMs to deadlineMs

Plan, recorded before the session was interrupted:

1. src/defaults.mjs: rename the default. Done.
2. src/parse.mjs: resolve deadlineMs; keep accepting timeoutMs as a deprecated alias (deadlineMs wins if both are
   given). Not started.
3. src/describe.mjs: say "deadline <n>ms, <r> retries". Not started.
4. node test.mjs must pass. Do not change test.mjs.
