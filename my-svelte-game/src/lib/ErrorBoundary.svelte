<script>
  export let error = null;
</script>

{#if error}
  <div style="color: red; padding: 1rem; border: 2px solid red;">
    <strong>Game Crashed!</strong><br>
    {error.message}
    <pre>{error.stack}</pre>
  </div>
{:else}
  <slot />
{/if}