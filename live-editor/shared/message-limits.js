export const PANEL_MESSAGE_LIMIT = 500;
// The 80-second overlay window can intersect 81 per-second buckets. At the
// existing 50 comments/second maximum, all 4050 comments fit in this response.
export const OVERLAY_MESSAGE_LIMIT = 4096;
