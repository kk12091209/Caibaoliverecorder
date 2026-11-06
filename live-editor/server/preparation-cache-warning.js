import {BYTES_PER_GB,BYTES_PER_GIB as GiB,MAX_CACHE_WARNING_GIB,cacheWarningInGiB} from '../shared/cache-warning-units.js';
export const DEFAULT_CACHE_WARNING_GIB = cacheWarningInGiB(50);
export const validCacheWarningGiB = value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_CACHE_WARNING_GIB;

// Older clients still submit integral GiB. GB inputs are converted to an
// exact byte count, represented as a fractional GiB in the existing setting.
export const validCacheWarningThreshold=value=>typeof value==='number'&&Number.isSafeInteger(value*GiB)&&value*GiB>=BYTES_PER_GB&&value<=MAX_CACHE_WARNING_GIB;

export function cacheWarningSettings(store) {
  const saved = store.setting('preparationCacheWarningGiB');
  // Preserve an explicitly saved quota as a reminder. Unset values use 50 GB.
  const legacy = store.setting('preparationCacheGiB');
  return {
    warningGiB: validCacheWarningThreshold(saved) ? saved : validCacheWarningGiB(legacy) ? legacy : DEFAULT_CACHE_WARNING_GIB,
    warningEnabled: store.setting('preparationCacheWarningEnabled') !== false,
  };
}

function readCycle(store, thresholdGiB) {
  const saved = store.setting('preparationCacheWarningState');
  if (saved && Number.isSafeInteger(saved.cycle) && saved.cycle >= 0 &&
      typeof saved.above === 'boolean' && typeof saved.acknowledged === 'boolean' && validCacheWarningThreshold(saved.thresholdGiB)) return {...saved};
  // Earlier local builds stored acknowledgement as a permanent opt-out.
  // Preserve it for the current accumulation period, not for future periods.
  const acknowledged = store.setting('preparationCacheWarningAcknowledged') === true;
  return {cycle:acknowledged ? 1 : 0, above:acknowledged, acknowledged, thresholdGiB};
}

export function cacheWarningSnapshot(store, cache) {
  if (!cache) return cache;
  const settings = cacheWarningSettings(store);
  const state = readCycle(store, settings.warningGiB);
  const ready = cache.inventoryReady === true && Number.isFinite(cache.usedBytes) && cache.usedBytes >= 0;
  // Startup snapshots contain only the sessions loaded so far. They must not
  // look like a cleanup and reset an acknowledged period after every restart.
  if (ready) {
    if (state.thresholdGiB !== settings.warningGiB) {
      state.thresholdGiB = settings.warningGiB;
      state.above = false;
      state.acknowledged = false;
    }
    const above = cache.usedBytes >= settings.warningGiB * GiB;
    if (above && !state.above) state.cycle++;
    if (!above) state.acknowledged = false;
    state.above = above;
    if (JSON.stringify(store.setting('preparationCacheWarningState')) !== JSON.stringify(state)) store.setting('preparationCacheWarningState', state);
  }
  return {...cache, ...settings, warningCycle:state.cycle, warningAcknowledged:state.acknowledged,
    warningDue:ready && settings.warningEnabled && state.above && !state.acknowledged};
}

export function acknowledgeCacheWarning(store, cache, {cycle, thresholdGiB}) {
  const current = cacheWarningSnapshot(store, cache);
  // A late response from an older dialog must not acknowledge a new period.
  if (current.warningDue && current.warningCycle === cycle && current.warningGiB === thresholdGiB) {
    store.setting('preparationCacheWarningState', {...readCycle(store, thresholdGiB), acknowledged:true});
  }
}
