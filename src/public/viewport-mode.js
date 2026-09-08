// Telling a soft keyboard apart from a real viewport change.
//
// This matters because the two demand opposite responses. A rotation or a
// window resize should re-fit the terminal: the usable area really did change.
// A keyboard must NOT, because re-fitting sends the new row count to the pty
// and Claude re-lays-out its whole UI for it — measured on a phone, 38 rows
// became 21, which left Claude a 14-row content area and made replies scroll
// away after a dozen lines. The keyboard is transient furniture in front of the
// terminal, not a smaller terminal.
//
// Pure and separate so it can be unit-tested; the DOM wiring lives in app.js.

var VIEWPORT = (function () {
  // How much of the layout viewport has to disappear before we call it a
  // keyboard. Soft keyboards take roughly a third to a half of a phone screen;
  // browser chrome appearing on scroll takes far less, and must not count.
  var KEYBOARD_MIN_SHRINK = 0.15;

  // `layout` is the window's own idea of its size (unchanged by the keyboard);
  // `visual` is what visualViewport reports (shrunk by it). Width is the tell:
  // a keyboard never changes it, a rotation always does.
  function isKeyboardOpen(layout, visual) {
    if (!layout || !visual) return false;
    if (!(layout.height > 0) || !(visual.height > 0)) return false;
    // A rotation changes the width too; treat that as a real resize even if the
    // height also dropped, or we would freeze the terminal at the old geometry.
    if (Math.abs(layout.width - visual.width) > 2) return false;
    return (layout.height - visual.height) / layout.height >= KEYBOARD_MIN_SHRINK;
  }

  return { KEYBOARD_MIN_SHRINK: KEYBOARD_MIN_SHRINK, isKeyboardOpen: isKeyboardOpen };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VIEWPORT;
