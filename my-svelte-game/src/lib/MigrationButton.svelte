<script>
  import { migrateHighScoresToFirestore } from '$lib/migrate-highscores.js';
  import { dev } from '$app/environment';
  
  let migrating = false;
  let result = null;
  let error = null;
  
  async function runMigration() {
    migrating = true;
    error = null;
    result = null;
    
    try {
      result = await migrateHighScoresToFirestore();
      console.log('[Migration Button] Success:', result);
    } catch (err) {
      error = err.message;
      console.error('[Migration Button] Error:', err);
    } finally {
      migrating = false;
    }
  }
</script>

{#if dev}
  <div style="position: fixed; top: 10px; right: 10px; z-index: 9999; background: rgba(0,0,0,0.8); padding: 15px; border-radius: 8px; color: white; font-family: monospace; font-size: 12px; max-width: 300px;">
    <h3 style="margin: 0 0 10px 0; font-size: 14px;">🔄 Firestore Migration</h3>
    
    <button 
      on:click={runMigration}
      disabled={migrating}
      style="padding: 8px 16px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; width: 100%;"
    >
      {migrating ? '⏳ Migrating...' : '▶ Start Migration'}
    </button>
    
    {#if result}
      <div style="margin-top: 10px; padding: 10px; background: rgba(76, 175, 80, 0.2); border-radius: 4px;">
        <div style="color: #4CAF50; font-weight: bold;">✓ Migration Complete!</div>
        <div style="margin-top: 5px;">
          <div>✓ Migrated: <strong>{result.migrated}</strong></div>
          <div>⊘ Skipped: <strong>{result.skipped}</strong></div>
          <div>✗ Errors: <strong>{result.errors}</strong></div>
        </div>
      </div>
    {/if}
    
    {#if error}
      <div style="margin-top: 10px; padding: 10px; background: rgba(244, 67, 54, 0.2); border-radius: 4px; color: #f44336;">
        <div style="font-weight: bold;">✗ Error:</div>
        <div style="margin-top: 5px; font-size: 11px;">{error}</div>
      </div>
    {/if}
    
    <div style="margin-top: 10px; font-size: 10px; opacity: 0.7;">
      Dev mode only - Check console for details
    </div>
  </div>
{/if}
