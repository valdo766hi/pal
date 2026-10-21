if (process.send !== undefined) {
  process.on("message", (message) => {
    if (
      message === null ||
      typeof message !== "object" ||
      message.kind !== "pal-startup-rss" ||
      typeof message.id !== "string"
    )
      return;
    process.send?.(
      { kind: "pal-startup-rss", id: message.id, pid: process.pid, rssBytes: process.memoryUsage.rss() },
      () => {},
    );
  });
  process.once("disconnect", () => process.kill(process.pid, "SIGTERM"));
  // The observer must not keep an otherwise stopped process alive.
  process.channel?.unref();
}
