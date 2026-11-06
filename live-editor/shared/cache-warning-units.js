export const BYTES_PER_GB=1_000_000_000;
export const BYTES_PER_GIB=1024**3;
export const MAX_CACHE_WARNING_GIB=1048576;
export const MAX_CACHE_WARNING_GB=MAX_CACHE_WARNING_GIB*BYTES_PER_GIB/BYTES_PER_GB;
export const cacheWarningInGB=thresholdGiB=>thresholdGiB*BYTES_PER_GIB/BYTES_PER_GB;
export const cacheWarningInGiB=thresholdGB=>Math.round(thresholdGB*BYTES_PER_GB)/BYTES_PER_GIB;
export const validCacheWarningGB=value=>Number.isFinite(value)&&value>=1&&value<=MAX_CACHE_WARNING_GB;
