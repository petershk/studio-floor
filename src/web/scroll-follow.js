// Newest-first feeds. If we always set scrollTop = 0 after a rebuild, anyone
// reading older lines is yanked back to the top on every poll. Follow the newest
// line only when the reader is already there; otherwise keep their place relative
// to the bottom (the older end).

export const FOLLOW_PX = 16;

export function nextScrollTop({ scrollTop, scrollHeight, nextHeight, threshold = FOLLOW_PX }) {
  if (!Number.isFinite(scrollTop) || scrollTop <= threshold) return 0;
  const fromBottom = (Number(scrollHeight) || 0) - scrollTop;
  return Math.max(0, (Number(nextHeight) || 0) - fromBottom);
}

export function refillKeepingPlace(el, fill) {
  const scrollTop = el.scrollTop;
  const scrollHeight = el.scrollHeight;
  fill();
  el.scrollTop = nextScrollTop({ scrollTop, scrollHeight, nextHeight: el.scrollHeight });
}
