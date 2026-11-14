<script lang="ts">
  import { chooseRing, ring } from "./choice.svelte.ts";
</script>

<h2 class="h2">Context ring</h2>
<p class="sub">
  A small ring beside the message box shows how full the model's context is. Click it for a breakdown of what fills it.
  It reads Pal's estimates of the last prepared request: no tools, network or model requests.
</p>
<section aria-labelledby="ring-title">
  <div class="setrow">
    <label for="ring-show">
      <div class="setl" id="ring-title">Context ring</div>
      <div class="setd">Saved in this browser only. Off removes it from every chat.</div>
    </label>
    <input
      id="ring-show"
      class="swi"
      type="checkbox"
      role="switch"
      checked={ring.shown}
      onchange={(event) => chooseRing({ ...ring, shown: event.currentTarget.checked })}
    />
  </div>
  <div class="setrow">
    <label for="ring-percent">
      <div class="setl">Show the percentage</div>
      <div class="setd">Beside the ring; tokens instead when the model's window is unknown.</div>
    </label>
    <input
      id="ring-percent"
      class="swi"
      type="checkbox"
      role="switch"
      checked={ring.percent}
      disabled={!ring.shown}
      onchange={(event) => chooseRing({ ...ring, percent: event.currentTarget.checked })}
    />
  </div>
</section>
