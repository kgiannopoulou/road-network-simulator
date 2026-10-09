import { Graph } from './graph.js';

const STORAGE_KEY = 'road-network-simulator.graph.v1';

/** Returns the saved graph, or null if nothing is stored / storage is unavailable. */
export function loadGraph() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Graph.fromJSON(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveGraph(graph) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(graph.toJSON()));
    return true;
  } catch {
    return false;
  }
}

export function downloadGraph(graph, filename = 'road-network.json') {
  const blob = new Blob([JSON.stringify(graph.toJSON(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

export async function readGraphFile(file) {
  return Graph.fromJSON(JSON.parse(await file.text()));
}
