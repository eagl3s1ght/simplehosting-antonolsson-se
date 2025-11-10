# Firestore Migration Checklist

## Pre-Migration Setup
- [ ] Enable Firestore in Firebase Console (test mode)
- [ ] Deploy security rules: `firebase deploy --only firestore:rules,firestore:indexes`
- [ ] Verify rules are active in Firebase Console

## Data Migration
- [ ] Run migration script (browser console or migration button)
- [ ] Verify data in Firebase Console → Firestore Database → highScores collection
- [ ] Confirm all expected scores migrated (check console logs)

## Code Integration
- [ ] Add `saveHighScoreFirestore()` calls where scores are saved
- [ ] Replace `fetchHighscores()` with `getHighScoresFirestore()`
- [ ] Test locally: `npm run dev -- --host`
- [ ] Verify leaderboard loads correctly
- [ ] Play a game and verify score saves to Firestore

## Testing
- [ ] Check browser console for errors
- [ ] Verify high scores appear in Firebase Console
- [ ] Test with multiple players (or incognito windows)
- [ ] Confirm leaderboard updates correctly

## Production Deployment
- [ ] Build: `npm run build`
- [ ] Copy to public: `cp -r build/* ../public/`
- [ ] Deploy: `firebase deploy`
- [ ] Test production site
- [ ] Monitor Firebase Console → Usage tab

## Post-Deployment
- [ ] Set up usage alerts (80% threshold)
- [ ] Monitor for 1 week alongside RTDB
- [ ] Confirm no errors in production
- [ ] (Optional) Remove RTDB high score code after 2-4 weeks

## Rollback Plan (If Needed)
- [ ] Keep RTDB calls active for 2-4 weeks as backup
- [ ] If issues arise, can temporarily disable Firestore calls
- [ ] Original RTDB high scores remain untouched

---

**Estimated Time:** 15-30 minutes (excluding monitoring period)

**Files Changed:**
- ✅ `firestore.rules` (new)
- ✅ `firestore.indexes.json` (new)
- ✅ `firebase.json` (updated)
- ✅ `src/lib/firebase.js` (updated with new functions)
- ✅ `src/lib/migrate-highscores.js` (new)

**Next Steps:** Follow `docs/FIRESTORE_QUICK_START.md` for copy-paste ready code!
