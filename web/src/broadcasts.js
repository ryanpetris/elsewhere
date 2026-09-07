// Presets are shared by same-origin desktops, independent of their URL prefixes.
import { api } from './api.js';
export const PRESET_PREFIX = 'elsewhere.broadcastPreset.';
export function loadPresets() {
  const result = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PRESET_PREFIX)) continue;
    try { const value = JSON.parse(localStorage.getItem(key)); if (value && typeof value === 'object' && typeof value.label === 'string') result.push({ ...value, preset_id: key.slice(PRESET_PREFIX.length) }); } catch {}
  }
  return result.sort((a, b) => a.label.localeCompare(b.label));
}
export const savePreset = preset => localStorage.setItem(PRESET_PREFIX + preset.preset_id, JSON.stringify(preset));
export const removePreset = id => localStorage.removeItem(PRESET_PREFIX + id);
async function request(path, body) {
  const response = await api('/api/broadcasts' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Broadcast request failed.');
  return result;
}
export const listBroadcasts = () => request('');
export const broadcastCapabilities = () => request('/capabilities');
export const startBroadcast = settings => request('/start', settings);
export const stopBroadcast = id => request('/' + encodeURIComponent(id) + '/stop', {});
