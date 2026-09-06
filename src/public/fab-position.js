// Geometry for the mobile floating buttons (ESC / MODE), kept apart from the
// drag wiring in app.js so it can be unit-tested. Everything here is pure: no
// DOM, no storage — callers pass in the viewport they measured.
//
// Position is stored as a SIDE plus a RATIO of viewport height, not pixels.
// A phone rotates, and 700px-from-the-top is off-screen in landscape; a ratio
// lands in the same visual place in both orientations.

var FAB = (function () {
  // Below this, a touch is a tap, not a drag. Fingers wobble on a plain tap and
  // a zero threshold would make the buttons impossible to press.
  var DRAG_THRESHOLD_PX = 8;

  // Keep the stack fully on screen: never under the tab bar, never past the
  // bottom safe area (the home indicator strip).
  function clampTop(top, v) {
    var min = v.topInset || 0;
    var max = (v.viewportHeight || 0) - (v.fabHeight || 0) - (v.bottomInset || 0);
    if (!(max > min)) return min;          // viewport too short to have a choice
    return Math.min(max, Math.max(min, top));
  }

  // Which edge to settle against once the finger lifts. Ties keep the current
  // side rather than picking one, so a button dropped exactly on the midline
  // does not flip sides on every drag.
  function snapSide(centerX, viewportWidth, currentSide) {
    var mid = (viewportWidth || 0) / 2;
    if (centerX < mid) return 'left';
    if (centerX > mid) return 'right';
    return currentSide === 'left' ? 'left' : 'right';
  }

  // What came out of localStorage is untrusted: it may be from an older build,
  // a different device, or hand-edited. Anything unusable becomes null, which
  // the caller reads as "no manual position, use the automatic one".
  function normalize(stored) {
    if (!stored || typeof stored !== 'object') return null;
    var side = stored.side === 'left' ? 'left' : (stored.side === 'right' ? 'right' : null);
    var ratio = Number(stored.yRatio);
    if (!side || !isFinite(ratio)) return null;
    return { side: side, yRatio: Math.min(1, Math.max(0, ratio)) };
  }

  // Ratio -> pixels for the current viewport, clamped so a position saved on a
  // taller screen cannot put the buttons out of reach on a shorter one.
  function topFromRatio(yRatio, v) {
    return clampTop(Math.round((Number(yRatio) || 0) * (v.viewportHeight || 0)), v);
  }

  function ratioFromTop(top, v) {
    var h = v.viewportHeight || 0;
    if (!h) return 0;
    return Math.min(1, Math.max(0, top / h));
  }

  return {
    DRAG_THRESHOLD_PX: DRAG_THRESHOLD_PX,
    clampTop: clampTop,
    snapSide: snapSide,
    normalize: normalize,
    topFromRatio: topFromRatio,
    ratioFromTop: ratioFromTop
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FAB;
