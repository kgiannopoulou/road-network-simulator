// Week 16: the champion (best brain ever trained) survives page reloads in localStorage.

export const CHAMPION_KEY = 'road-network-simulator.champion.v1';

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked (private mode, sandboxed iframe…)
  }
}

/** champion: { brain (Brain JSON), fitness, generation } */
export function saveChampion(champion, storage = defaultStorage()) {
  if (!storage || !champion) return false;
  try {
    storage.setItem(CHAMPION_KEY, JSON.stringify({ ...champion, savedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function loadChampion(storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const data = JSON.parse(storage.getItem(CHAMPION_KEY));
    return data?.brain?.network ? data : null;
  } catch {
    return null;
  }
}

export function clearChampion(storage = defaultStorage()) {
  try {
    storage?.removeItem(CHAMPION_KEY);
  } catch {
    // nothing to clear
  }
}
