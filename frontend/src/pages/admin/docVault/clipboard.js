/**
 * Put text on the clipboard, in a browser on any system (Windows included).
 *
 * The modern way, navigator.clipboard.writeText, needs a secure page (https)
 * and a click behind it, and some browsers refuse it in an embedded frame or
 * when the permission policy says no. When it is missing or refused, the old
 * way runs: a hidden text box is filled, selected and copied with
 * document.execCommand('copy'), which every desktop browser still honours
 * inside a click. Whichever works, the answer is true; when neither does it is
 * false, and the page says so and leaves the text on screen to select by hand.
 *
 * Line endings are left as they are (LF). Browsers, Word, Outlook and the
 * current Notepad all take LF; nothing here rewrites the owner's text.
 *
 * @param {string} text
 * @returns {Promise<boolean>} whether the text is now on the clipboard
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Refused (permission, frame, no focus): try the old way.
    }
  }
  return copyWithSelection(value);
}

function copyWithSelection(value) {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const box = document.createElement('textarea');
  box.value = value;
  box.setAttribute('readonly', '');
  box.setAttribute('aria-hidden', 'true');
  box.tabIndex = -1;
  Object.assign(box.style, {
    position: 'fixed',
    top: '0',
    left: '-9999px',
    width: '1px',
    height: '1px',
    opacity: '0',
  });
  const selection = document.getSelection?.();
  const kept = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const focused = document.activeElement;
  document.body.appendChild(box);
  try {
    box.focus();
    box.select();
    box.setSelectionRange(0, value.length);
    return Boolean(document.execCommand('copy'));
  } catch {
    return false;
  } finally {
    document.body.removeChild(box);
    if (kept && selection) {
      selection.removeAllRanges();
      selection.addRange(kept);
    }
    if (focused && typeof focused.focus === 'function') focused.focus();
  }
}
