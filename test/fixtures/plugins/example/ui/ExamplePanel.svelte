<script lang="ts">
  import type { PanelProps } from "../../../../../web/src/lib/plugins.ts";

  let { project, chat }: PanelProps = $props();
</script>

<p class="sub example">Example panel for {project.name} · {chat.title ?? "New chat"}</p>

<style>
  .example {
    padding: 14px;
  }
</style>
