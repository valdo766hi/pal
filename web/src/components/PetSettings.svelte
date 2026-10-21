<script lang="ts">
  import { PETS, type PetId, type Pose } from "../lib/pets.ts";
  import { app, choosePet } from "../lib/state.svelte.ts";
  import PetSprite from "./PetSprite.svelte";

  const pets = Object.entries(PETS) as [PetId, (typeof PETS)[PetId]][];
  const chosen: PetId = $derived(Object.hasOwn(PETS, app.pet.id) ? (app.pet.id as PetId) : "abuy");
  const moments: [Pose, string][] = [
    ["sit", "While you're here"],
    ["work", "While Pal works"],
    ["rest", "After 10 s idle"],
    ["nap", "After 30 s idle"],
  ];
</script>

<h2 class="h2">Pets</h2>
<p class="sub">
  A small pixel pet on the composer. It keeps you company, works along during a run and naps when Pal is idle. No tools,
  permissions, network or model requests.
</p>
<section aria-labelledby="pet-title">
  <div class="setrow">
    <label for="pet-show">
      <div class="setl" id="pet-title">Composer pet</div>
      <div class="setd">Saved in this browser only. Off unloads it.</div>
    </label>
    <input
      id="pet-show"
      class="swi"
      type="checkbox"
      role="switch"
      aria-label="Show the pet on the composer"
      checked={app.pet.enabled}
      onchange={(event) => choosePet({ ...app.pet, enabled: event.currentTarget.checked })}
    />
  </div>
  <div class="choices" role="radiogroup" aria-label="Pet">
    {#each pets as [id, pet] (id)}
      <label class="choice" class:on={chosen === id}>
        <input
          type="radio"
          name="pet"
          value={id}
          checked={chosen === id}
          disabled={!app.pet.enabled}
          onchange={() => choosePet({ ...app.pet, id })}
        />
        <span class="stage"><PetSprite {pet} pose="sit" scale={4} /></span>
        <span class="name">{pet.name}</span>
        <span class="note">{pet.kind}</span>
      </label>
    {/each}
  </div>
  <div class="detail">
    <p><strong>{PETS[chosen].name}</strong> · {PETS[chosen].about}</p>
    <ul class="poses" aria-label={`${PETS[chosen].name}'s poses`}>
      {#each moments as [pose, when] (pose)}
        <li>
          <span class="stage"><PetSprite pet={PETS[chosen]} {pose} scale={4} /></span>
          <span class="name">{PETS[chosen].poses[pose].label}</span>
          <span class="note">{when}</span>
        </li>
      {/each}
    </ul>
  </div>
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
    gap: 8px;
  }
  .choice {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 12px 8px 10px;
    border: 1px solid var(--line2);
    border-radius: var(--radius-md);
    background: var(--bg1);
    cursor: pointer;
    transition:
      border-color var(--fast) var(--ease),
      background-color var(--fast) var(--ease);
  }
  /* The radio covers its whole card, so a click anywhere lands on it. */
  .choice input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .choice:hover {
    background: var(--bg2);
  }
  .choice.on {
    border-color: var(--acln);
    background: var(--acbg);
  }
  .choice:has(input:focus-visible) {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .choice:has(input:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Sprites differ in size; each stands on the same floor. */
  .stage {
    height: 60px;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    margin-bottom: 6px;
  }
  .name {
    font-size: 13.5px;
    font-weight: 550;
  }
  .note {
    font-size: 12px;
    color: var(--tx3);
    text-align: center;
  }
  .detail {
    padding: 14px 16px 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg1);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .detail p {
    margin: 0;
    font-size: 13px;
    color: var(--tx2);
  }
  .detail strong {
    color: var(--tx);
    font-weight: 600;
  }
  .poses {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
  }
  .poses li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }
  .poses .stage {
    align-self: stretch;
    border-bottom: 1px solid var(--line2);
  }
</style>
