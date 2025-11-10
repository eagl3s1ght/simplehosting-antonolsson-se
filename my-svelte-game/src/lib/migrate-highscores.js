/**
 * ONE-TIME MIGRATION SCRIPT
 * Copies high scores from Firebase Realtime Database to Firestore
 * 
 * USAGE:
 * 1. Open browser console on your game page
 * 2. Copy and paste this entire script
 * 3. Run: await migrateHighScoresToFirestore()
 * 4. Check the console for progress and results
 */

import { get, ref } from 'firebase/database';
import { collection, addDoc } from 'firebase/firestore';
import { db, fsDb, ROOM } from '$lib/firebase.js';

/**
 * Migrate all high scores from RTDB to Firestore
 * @returns {Promise<{migrated: number, skipped: number, errors: number}>}
 */
export async function migrateHighScoresToFirestore() {
  console.log('[Migration] Starting high scores migration from RTDB to Firestore...');
  
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

// Make function available globally for easy browser console access
if (typeof window !== 'undefined') {
  window.migrateHighScoresToFirestore = migrateHighScoresToFirestore;
  console.log('[Migration] Script loaded! Run: await migrateHighScoresToFirestore()');
}
