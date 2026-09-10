// The on-screen keyboard's helper row: an invisible text field that keeps the phone's keyboard up and
// turns what it produces into typed text, and the keys such keyboards lack. Ctrl, Alt and Super are
// sticky: the next key or character goes with them.
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { IconButton, cx } from './ui.jsx';

/// Bring the phone's keyboard back for the row that is open (its own hide button dismissed it, and left
/// the field focused, so a plain focus() would do nothing).
export const focusKeyboard = () => { const el = document.querySelector('[data-keyboard]'); el?.blur(); el?.focus(); };

// DOM key names to xkb keysym names, for the keys that aren't text
const KEYSYM = { Escape: 'Escape', Tab: 'Tab', Enter: 'Return', Backspace: 'BackSpace', Delete: 'Delete', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next' };
const MODS = ['ctrl', 'alt', 'super'];
const KEYS = [['Esc', 'Escape'], ['Tab', 'Tab'], ['Ctrl', 'ctrl'], ['Alt', 'alt'], ['Super', 'super'], ['←', 'Left'], ['↑', 'Up'], ['↓', 'Down'], ['→', 'Right'], ['Del', 'Delete']];

export function Keyboard({ viewer, onClose }) {
  const field = useRef(null);
  const [mods, setMods] = useState([]);
  const sticky = useRef(mods); // what the native listeners below see
  sticky.current = mods;
  const chord = keys => { viewer.key([...sticky.current, keys].join('+')); setMods([]); };
  // text goes through the layout; with a sticky modifier its first character is a chord instead
  const typed = text => { if (sticky.current.length) { chord(text[0] === '+' ? 'plus' : text[0]); if (text.length > 1) viewer.type(text.slice(1)); } else viewer.type(text); };
  // native listeners: React's onBeforeInput is a polyfill without inputType
  useEffect(() => {
    const el = field.current;
    const beforeInput = e => {
      if (e.inputType === 'insertCompositionText') return; // delivered at compositionend
      e.preventDefault();
      if (e.inputType === 'insertText' && e.data) typed(e.data);
      else if (e.inputType === 'insertFromPaste') { const t = e.dataTransfer?.getData('text/plain'); if (t) typed(t); }
      else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') chord('Return');
      else if (e.inputType === 'deleteContentBackward') chord('BackSpace');
      else if (e.inputType === 'deleteContentForward') chord('Delete');
      else if (e.inputType === 'deleteWordBackward') chord('ctrl+BackSpace');
      else if (e.inputType === 'deleteWordForward') chord('ctrl+Delete');
    };
    const compositionEnd = e => { if (e.data) typed(e.data); el.value = ''; };
    el.addEventListener('beforeinput', beforeInput);
    el.addEventListener('compositionend', compositionEnd);
    el.focus();
    return () => { el.removeEventListener('beforeinput', beforeInput); el.removeEventListener('compositionend', compositionEnd); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // a physical keyboard's keys that aren't text (and its modifier chords) go as chords; phone keyboards
  // report most keys as 229 and deliver them through beforeinput instead
  const onKeyDown = e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (KEYSYM[e.key]) { e.preventDefault(); chord(KEYSYM[e.key]); }
    else if ((e.ctrlKey || e.altKey || e.metaKey) && e.key.length === 1) { e.preventDefault(); viewer.key(`${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.metaKey ? 'super+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key === '+' ? 'plus' : e.key}`); }
  };
  const keep = e => e.preventDefault(); // a tap on a key must not take the focus (and the phone's keyboard) away
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-surface px-2 py-1.5 text-xs">
      {KEYS.map(([label, key]) => (
        <button key={key} type="button" onPointerDown={keep} onClick={() => (MODS.includes(key) ? setMods(mods.includes(key) ? mods.filter(m => m !== key) : [...mods, key]) : chord(key))}
          className={cx('h-7 shrink-0 rounded-md border px-2 font-medium transition-colors', mods.includes(key) ? 'border-accent/50 bg-accent/15 text-accent-2' : 'border-line-2 bg-surface-3 text-ink-2 shadow-card active:bg-surface-4')}>
          {label}
        </button>
      ))}
      <input ref={field} data-keyboard="" onKeyDown={onKeyDown} onFocus={viewer.releaseInput}
        aria-label="Type Into Desktop" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        className="h-7 w-0 min-w-0 flex-1 rounded-md border border-dashed border-line-2 bg-transparent px-1 text-transparent caret-transparent outline-none focus:border-accent" />
      <IconButton icon={X} label="Hide Keyboard" size="sm" onClick={onClose} />
    </div>
  );
}
