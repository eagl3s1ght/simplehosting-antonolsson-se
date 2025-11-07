import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { getDatabase, ref, onValue, set, push, runTransaction, goOffline, goOnline } from 'firebase/database';
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

export async function joinGame(setState) {
  return signInAnonymously(auth).then((userCredential) => {
    const playerId = userCredential.user.uid;
    const playerData = {
      id: playerId,
      name: `Player ${Math.floor(Math.random()*100)}`,
      angle: Math.random() * Math.PI * 2,  // Random start
      score: 0
    };
    set(ref(db, `${ROOM}/players/${playerId}`), playerData);
    return { playerId, playerData };
  });
}

export function listenPlayers(setPlayers) {
  return onValue(ref(db, `${ROOM}/players`), (snap) => {
    const players = snap.val() || {};
    setPlayers(Object.values(players));
  });
}

export function listenFlows(setFlows) {
  return onValue(ref(db, `${ROOM}/flows`), (snap) => {
    const flows = snap.val() || {};
    setFlows(Object.values(flows));
  });
}

export function updateAngle(playerId, newAngle) {
  set(ref(db, `${ROOM}/players/${playerId}/angle`), newAngle);
}

export function incrementScore(playerId) {
  runTransaction(ref(db, `${ROOM}/players/${playerId}`), (player) => {
    if (player) player.score = (player.score || 0) + 1;
    return player;
  });
}

export function spawnFlow() {
  const flowRef = ref(db, `${ROOM}/flows`);
  runTransaction(ref(db, `${ROOM}/lastSpawn`), (lastTime) => {
    const now = Date.now();
    if (!lastTime || now - lastTime > 3000) {  // Spawn every 3s
      push(flowRef, {
        angle: Math.random() * Math.PI * 2,
        spawnTime: now
      });
      return now;
    }
    return lastTime;
  });
}