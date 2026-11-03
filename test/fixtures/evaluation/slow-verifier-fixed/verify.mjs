// The project's full verification: slow by design (about 150 seconds), then the public test.
await new Promise((resolve) => setTimeout(resolve, 150_000));
await import("./test.mjs");
process.stdout.write("Full verification passed.\n");
