/**
 * BROWSER CONSOLE VERSION - Migration Script
 * Copies high scores from Firebase Realtime Database to Firestore
 * 
 * USAGE:
 * 1. Make sure you're on your game page with Firebase loaded
 * 2. Copy and paste this ENTIRE script into browser console
 * 3. Run: await migrateHighScoresToFirestore()
 * 4. Check the console for progress and results
 */

async function migrateHighScoresToFirestore() {
  console.log('[Migration] Starting high scores migration from RTDB to Firestore...');
  
  // Import Firebase functions from the global scope (already loaded by your app)
  const { get, ref } = await import('firebase/database');
  const { collection, addDoc } = await import('firebase/firestore');
  
  // Access your Firebase instances (should be available globally from your app)
  const db = window.__firebase_db || document.querySelector('[data-firebase-db]')?.__firebase_db;
  const fsDb = window.__firebase_fsDb || document.querySelector('[data-firebase-fsdb]')?.__firebase_fsDb;
  const ROOM = 'publicGame';
  
  if (!db || !fsDb) {
    console.error('[Migration] Error: Firebase instances not found. Make sure the app is loaded.');
    console.log('[Migration] Try accessing from the game page, or use the UI button method instead.');
    return { migrated: 0, skipped: 0, errors: 0 };
  }
  
  let migrated = 0;
  let skipped = 0;
  let errors = 0;
  
  try {
    // Fetch all high scores from RTDB
    const rtdbScores = await get(ref(db, `${ROOM}/highscores`));
    
    if (!rtdbScores.exists()) {
      console.log('[Migration] No high scores found in RTDB');
      return { migrated: 0, skipped: 0, errors: 0 };
    }
    
    const scores = rtdbScores.val();
    const totalScores = Object.keys(scores).length;
    console.log(`[Migration] Found ${totalScores} high scores in RTDB`);
    
    // Migrate each score
    for (const [userId, scoreData] of Object.entries(scores)) {
      try {
        // Skip bot and local co-op players
        if (userId.startsWith('bot-') || userId.startsWith('local-p2-')) {
          console.log(`[Migration] Skipping bot/co-op player: ${userId}`);
          skipped++;
          continue;
        }
        
        // Prepare Firestore document
        const firestoreDoc = {
          userId: userId,
          name: scoreData.name || 'Anonymous',
          score: scoreData.totalCatches || 0,
          colorIndex: scoreData.colorIndex || 0,
          country: scoreData.country || null,
          date: scoreData.lastUpdated ? new Date(scoreData.lastUpdated) : new Date(),
          lastUpdated: new Date(),
          // Preserve additional metadata
          evilHits: scoreData.evilHits || 0,
          migratedFrom: 'rtdb',
          migrationDate: new Date()
        };
        
        // Add to Firestore
        await addDoc(collection(fsDb, 'highScores'), firestoreDoc);
        migrated++;
        console.log(`[Migration] ✓ Migrated ${userId}: ${firestoreDoc.score} catches`);
        
      } catch (error) {
        console.error(`[Migration] ✗ Failed to migrate ${userId}:`, error);
        errors++;
      }
    }
    
    console.log('[Migration] =====================================');
    console.log(`[Migration] Migration complete!`);
    console.log(`[Migration]   Migrated: ${migrated}`);
    console.log(`[Migration]   Skipped: ${skipped}`);
    console.log(`[Migration]   Errors: ${errors}`);
    console.log('[Migration] =====================================');
    
    return { migrated, skipped, errors };
    
  } catch (error) {
    console.error('[Migration] Fatal error during migration:', error);
    throw error;
  }
}

console.log('[Migration] ✓ Script loaded! Run: await migrateHighScoresToFirestore()');
