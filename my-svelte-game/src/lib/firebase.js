/** Remove all flows from the database, regardless of spawnTime. For debug use only. */
export async function removeAllFlows() {
  try {
    const q = query(ref(db, `${ROOM}/flows`));
    const snap = await get(q);
    if (!snap.exists()) return 0;
    /** @type {Promise<any>[]} */
    const removals = [];
    snap.forEach((child) => {
      removals.push(remove(ref(db, `${ROOM}/flows/${child.key}`)).catch(err => {
        console.warn(`[removeAllFlows] Failed to remove flow ${child.key}:`, err);
      }));
    });
    await Promise.all(removals);
    return removals.length;
  } catch (e) {
    console.warn('removeAllFlows error', e);
    return 0;
  }
}
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, onValue, set, push, runTransaction, goOffline, goOnline, query, orderByChild, limitToLast, endAt, get, remove, equalTo } from 'firebase/database';
import { v4 as uuidv4 } from 'uuid';
const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

export const ROOM = 'publicGame';  // Single global room

/** @param {(state:any)=>void} setState */
export async function joinGame(setState) {
  return signInAnonymously(auth).then((userCredential) => {
    const playerId = userCredential.user.uid;
    // Minimal player meta: keep only country, language, creationTime, lastSignInTime
    let meta = {};
    try {
      meta = {
        creationTime: userCredential.user.metadata?.creationTime || null,
        lastSignInTime: userCredential.user.metadata?.lastSignInTime || null,
        language: typeof navigator !== 'undefined' ? navigator.language : null,
        country: (typeof navigator !== 'undefined' && navigator.language && navigator.language.includes('-'))
          ? navigator.language.split('-')[1].toUpperCase()
          : null
      };
    } catch {}
    const playerData = {
      id: playerId,
      angle: Math.random() * Math.PI * 2,  // Random start
      score: 0,
      layer: 0,  // Start at innermost layer
      colorIndex: Math.floor(Math.random() * 12), // Tentative; UI will adjust to unused
      createdAt: Date.now(), // Persist creation timestamp for visibility across clients
      active: true,
      meta
    };
    set(ref(db, `${ROOM}/players/${playerId}`), playerData);
    return { playerId, playerData };
  });
}

/** Clean up players' meta objects to only include allowed fields.
 * Keeps: country, language, creationTime, lastSignInTime.
 * Returns number of player records updated.
 */
export async function cleanupPlayerMeta() {
  try {
    const snap = await get(ref(db, `${ROOM}/players`));
    if (!snap.exists()) return 0;
    /** @type {Promise<any>[]} */
    const writes = [];
    let updated = 0;
    snap.forEach((child) => {
      const val = child.val() || {};
      const m = val.meta || {};
      const newMeta = {
        country: (typeof m.country === 'string' ? m.country : null),
        language: (typeof m.language === 'string' ? m.language : null),
        creationTime: typeof m.creationTime === 'string' ? m.creationTime : null,
        lastSignInTime: typeof m.lastSignInTime === 'string' ? m.lastSignInTime : null
      };
      // Check if there are extra fields in the old meta
      const oldKeys = Object.keys(m);
      const newKeys = Object.keys(newMeta);
      const hasExtraFields = oldKeys.some(k => !newKeys.includes(k));
      const valuesDiffer = newKeys.some(k => m[k] !== newMeta[/** @type {keyof typeof newMeta} */(k)]);
      
      if (hasExtraFields || valuesDiffer) {
        updated++;
        console.log(`[cleanupPlayerMeta] Updating player ${child.key}:`, { old: m, new: newMeta });
        writes.push(set(ref(db, `${ROOM}/players/${child.key}/meta`), newMeta).catch(err => {
          console.warn('[cleanupPlayerMeta] Failed to update', child.key, err);
        }));
      }
    });
    await Promise.all(writes);
    return updated;
  } catch (e) {
    console.warn('cleanupPlayerMeta error', e);
    return 0;
  }
}

/** @param {(players:any)=>void} setPlayers */
export function listenPlayers(setPlayers) {
  return onValue(ref(db, `${ROOM}/players`), (snap) => {
    const players = snap.val() || {};
    setPlayers(Object.values(players));
  });
}

/** @param {(flows:any)=>void} setFlows 
  * @param {number} [limit=100] */
export function listenFlows(setFlows, limit = 100) {
  const q = query(ref(db, `${ROOM}/flows`), orderByChild('spawnTime'), limitToLast(limit));
  return onValue(q, (snap) => {
    const flows = snap.val() || {};
    // Pass object map; caller can decide to convert to values
    setFlows(flows);
  });
}

/** @param {string} playerId 
  * @param {number} newAngle */
export function updateAngle(playerId, newAngle) {
  if (!playerId || typeof newAngle !== 'number' || isNaN(newAngle)) {
    console.warn('Invalid updateAngle call', { playerId, newAngle });
    return;
  }
  try {
    set(ref(db, `${ROOM}/players/${playerId}/angle`), newAngle).catch(err => {
      console.warn('Failed to update angle:', err.message);
    });
  } catch (err) {
    if (err instanceof Error) console.warn('updateAngle error:', err.message);
    else console.warn('updateAngle error:', err);
  }
}

/** @param {string} playerId 
  * @param {number} newLayer */
export function updateLayer(playerId, newLayer) {
  if (!playerId || typeof newLayer !== 'number' || isNaN(newLayer)) {
    console.warn('Invalid updateLayer call', { playerId, newLayer });
    return;
  }
  try {
    set(ref(db, `${ROOM}/players/${playerId}/layer`), newLayer).catch(err => {
      console.warn('Failed to update layer:', err.message);
    });
  } catch (err) {
    if (err instanceof Error) console.warn('updateLayer error:', err.message);
    else console.warn('updateLayer error:', err);
  }
}

/** Mark player active/inactive. */
/**
 * @param {string} playerId
 * @param {boolean} isActive
 */
export function setPlayerActive(playerId, isActive) {
  if (!playerId) return;
  try {
    set(ref(db, `${ROOM}/players/${playerId}/active`), !!isActive).catch(err => {
      console.warn('Failed to set active flag:', err?.message || err);
    });
  } catch (e) {
    console.warn('setPlayerActive error', e);
  }
}

/** Update the player's lastSeen timestamp (ms since epoch). */
/**
 * @param {string} playerId
 */
export function setLastSeen(playerId) {
  if (!playerId) return;
  try {
    set(ref(db, `${ROOM}/players/${playerId}/lastSeen`), Date.now()).catch(err => {
      console.warn('Failed to update lastSeen:', err?.message || err);
    });
  } catch (e) {
    console.warn('setLastSeen error', e);
  }
}

/** @param {string} playerId 
  * @param {number} colorIndex */
export function updateColor(playerId, colorIndex) {
  if (!playerId || typeof colorIndex !== 'number' || isNaN(colorIndex)) {
    console.warn('Invalid updateColor call', { playerId, colorIndex });
    return;
  }
  try {
    set(ref(db, `${ROOM}/players/${playerId}/colorIndex`), colorIndex).catch(err => {
      console.warn('Failed to update color:', err.message);
    });
  } catch (err) {
    if (err instanceof Error) console.warn('updateColor error:', err.message);
    else console.warn('updateColor error:', err);
  }
}

/** @param {string} playerId */
export function incrementScore(playerId) {
  runTransaction(ref(db, `${ROOM}/players/${playerId}`), (player) => {
    if (player) player.score = (player.score || 0) + 1;
    return player;
  });
}

/** @param {string} playerId */
export function decrementScore(playerId) {
  runTransaction(ref(db, `${ROOM}/players/${playerId}`), (player) => {
    if (player) player.score = Math.max(0, (player.score || 0) - 1);
    return player;
  });
}

export function spawnFlow(isEvil = false, extra = {}) {
  const flowRef = ref(db, `${ROOM}/flows`);
  const now = Date.now();
  const layer = Math.floor(Math.random() * 5);
  push(flowRef, {
    angle: Math.random() * Math.PI * 2,
    spawnTime: now,
    isEvil,
    layer,
    ...extra
  });
}

/** Update the layer of a specific flow by Firebase key. */
/**
 * @param {string} flowKey
 * @param {number} newLayer
 */
export function updateFlowLayer(flowKey, newLayer) {
  if (!flowKey || typeof newLayer !== 'number' || isNaN(newLayer)) return;
  try {
    set(ref(db, `${ROOM}/flows/${flowKey}/layer`), newLayer).catch(err => {
      console.warn('Failed to update flow layer', flowKey, err?.message || err);
    });
  } catch (e) {
    console.warn('updateFlowLayer error', e);
  }
}

/** Remove all flows with layer == 5 (outer-expired). Requires indexOn "layer" in rules for performance. */
export async function removeLayer5Flows(batchLimit = 1000) {
  try {
    const q = query(ref(db, `${ROOM}/flows`), orderByChild('layer'), equalTo(5), limitToLast(batchLimit));
    const snap = await get(q);
    if (!snap.exists()) return 0;
    /** @type {Promise<any>[]} */
    const removals = [];
    snap.forEach((child) => {
      removals.push(remove(ref(db, `${ROOM}/flows/${child.key}`)).catch(err => {
        console.warn('[removeLayer5Flows] Failed to remove', child.key, err);
      }));
    });
    await Promise.all(removals);
    return removals.length;
  } catch (e) {
    console.warn('removeLayer5Flows error (will fallback to client-side filter)', e);
    // Fallback: fetch without index and filter client-side (less efficient)
    try {
      const snap = await get(ref(db, `${ROOM}/flows`));
      if (!snap.exists()) return 0;
      /** @type {Promise<any>[]} */
      const removals = [];
      let count = 0;
      snap.forEach((child) => {
        if (count >= batchLimit) return;
        const val = child.val() || {};
        if (val && val.layer === 5) {
          count++;
          removals.push(remove(ref(db, `${ROOM}/flows/${child.key}`)).catch(err => {
            console.warn('[removeLayer5Flows:fallback] Failed to remove', child.key, err);
          }));
        }
      });
      await Promise.all(removals);
      return removals.length;
    } catch (e2) {
      console.warn('removeLayer5Flows fallback error', e2);
      return 0;
    }
  }
}

/** Increment lifetime catch stats for a player.
 * @param {string} playerId
 * @param {string} [name]
 * @param {number} [colorIndex]
 */
/** Increment lifetime catch stats for a player.
 * @param {string} playerId
 * @param {number} [colorIndex]
 */
/** @param {string} playerId 
  * @param {number} [colorIndex]
  * @param {string} [countryCode] two-letter ISO code
  */
export function recordCatch(playerId, colorIndex, countryCode) {
  const hsRef = ref(db, `${ROOM}/highscores/${playerId}`);
  const now = Date.now();
  runTransaction(hsRef, (hs) => {
    hs = hs || { totalCatches: 0, evilHits: 0 };
    hs.totalCatches = (hs.totalCatches || 0) + 1;
    hs.lastUpdated = now;
    if (typeof colorIndex === 'number') hs.colorIndex = colorIndex;
    if (typeof countryCode === 'string' && countryCode.length === 2) hs.country = countryCode.toUpperCase();
    return hs;
  });
}

/** Increment lifetime evil-hit stats for a player.
 * @param {string} playerId
 */
export function recordEvilHit(playerId) {
  const hsRef = ref(db, `${ROOM}/highscores/${playerId}`);
  const now = Date.now();
  runTransaction(hsRef, (hs) => {
    hs = hs || { totalCatches: 0, evilHits: 0 };
    hs.evilHits = (hs.evilHits || 0) + 1;
    hs.lastUpdated = now;
    return hs;
  });
}

/** Remove old flows by spawnTime cutoff (in ms ago). Safe to call ad-hoc.
 * @param {number} maxAgeMs
 * @param {number} [batchLimit=500]
 */
export async function pruneOldFlows(maxAgeMs = 60000, batchLimit = 500) {
  try {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    const q = query(ref(db, `${ROOM}/flows`), orderByChild('spawnTime'), limitToLast(batchLimit));
    const snap = await get(q);
    if (!snap.exists()) return 0;
    /** @type {Promise<any>[]} */
    const removals = [];
    snap.forEach((child) => {
      const val = child.val() || {};
      const st = val.spawnTime;
      const key = child.key;
      // Prune if spawnTime is missing, not a number, too old, or more than 1 minute in the future
      if (
        typeof st !== 'number' ||
        isNaN(st) ||
        st <= cutoff ||
        st > now + 60000
      ) {
        console.log(`[pruneOldFlows] Removing flow:`, key, val);
        removals.push(
          remove(ref(db, `${ROOM}/flows/${key}`)).then(() => {
            console.log(`[pruneOldFlows] Successfully removed flow:`, key);
          }).catch(err => {
            console.warn(`[pruneOldFlows] Failed to remove flow ${key}:`, err);
          })
        );
      }
    });
    await Promise.all(removals);
    return removals.length;
  } catch (e) {
    console.warn('pruneOldFlows error', e);
    return 0;
  }
}

/** Analyze database size and return a tree structure with byte counts.
 * @returns {Promise<any>}
 */
export async function analyzeDbSize() {
  try {
    const snap = await get(ref(db, ROOM));
    if (!snap.exists()) return { total: 0, tree: {} };
    
    const data = snap.val();
    /** @type {Record<string, any>} */
    const tree = {};
    let total = 0;
    
    for (const [key, value] of Object.entries(data)) {
      const json = JSON.stringify(value);
      const bytes = new TextEncoder().encode(json).length;
      tree[key] = {
        bytes,
        count: value && typeof value === 'object' ? Object.keys(value).length : 1,
        sample: value && typeof value === 'object' ? Object.keys(value).slice(0, 3) : null
      };
      total += bytes;
    }
    
    return { total, tree };
  } catch (e) {
    console.warn('analyzeDbSize error', e);
    return { total: 0, tree: {} };
  }
}

/** Fetch top highscores by totalCatches (client reverses ascending order).
 * @param {number} [limit=20]
 * @returns {Promise<any[]>}
 */
/** @param {number} [limit=20] */
export async function fetchHighscores(limit = 20) {
  const q = query(ref(db, `${ROOM}/highscores`), orderByChild('totalCatches'), limitToLast(limit));
  const snap = await get(q);
  /** @type {{id:string,totalCatches?:number,evilHits?:number,name?:string,colorIndex?:number,country?:string,lastUpdated?:number}[]} */
  const list = [];
  if (snap.exists()) {
    snap.forEach((child) => {
      list.push({ id: child.key, ...(child.val() || {}) });
    });
  }
  // Reverse to descending by totalCatches
  list.sort((a, b) => (b.totalCatches || 0) - (a.totalCatches || 0));
  return list;
}