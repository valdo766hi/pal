<script lang="ts">
  import type { RendererProps } from "../../../../../web/src/lib/plugins.ts";

  let { entry }: RendererProps = $props();
  const text = $derived((entry.data as { text?: string } | undefined)?.text ?? "");
</script>

<p class="note">Example echo: {text}</p>
