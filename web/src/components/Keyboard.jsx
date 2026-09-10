// An on-screen keyboard and a device-IME field, both sending input through the compositor's layout.
import { useEffect, useRef, useState } from 'react';
import SimpleKeyboard from 'react-simple-keyboard';
import 'react-simple-keyboard/build/css/index.css';
import { X } from 'lucide-react';
import { IconButton } from './ui.jsx';

// DOM key names to xkb keysym names, for the keys that aren't text
const KEYSYM = { Escape: 'Escape', Tab: 'Tab', Enter: 'Return', Backspace: 'BackSpace', Delete: 'Delete', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next' };
const MODS = ['ctrl', 'alt', 'super', 'shift'];
const NAMED = { '{esc}': 'Escape', '{tab}': 'Tab', '{enter}': 'Return', '{bksp}': 'BackSpace', '{del}': 'Delete', '{left}': 'Left', '{right}': 'Right', '{up}': 'Up', '{down}': 'Down' };
const LAYOUT = {
  default: ['{esc} 1 2 3 4 5 6 7 8 9 0 {bksp}', 'q w e r t y u i o p', '{tab} a s d f g h j k l {enter}', '{shift} z x c v b n m , . {shift}', "` - = [ ] \\ ; ' /", '{ctrl} {alt} {super} {space} {left} {down} {up} {right} {del}'],
  shift: ['{esc} ! @ # $ % ^ & * ( ) {bksp}', 'Q W E R T Y U I O P', '{tab} A S D F G H J K L {enter}', '{shift} Z X C V B N M < > {shift}', '~ _ + { } | : " ?', '{ctrl} {alt} {super} {space} {left} {down} {up} {right} {del}'],
};
const DISPLAY = { '{esc}': 'Esc', '{tab}': 'Tab', '{enter}': 'Return', '{bksp}': '⌫', '{del}': 'Del', '{ctrl}': 'Ctrl', '{alt}': 'Alt', '{super}': 'Super', '{shift}': 'Shift', '{space}': 'Space', '{left}': '←', '{down}': '↓', '{up}': '↑', '{right}': '→' };

export function Keyboard({ viewer, onClose }) {
  const field = useRef(null);
  const keyboard = useRef(null);
  const [mods, setMods] = useState([]);
  const sticky = useRef([]);
  const setSticky = next => { sticky.current = next; setMods(next); };
  const chord = keys => { viewer.key([...sticky.current, keys].join('+')); setSticky([]); };
  // text goes through the layout; with a sticky modifier its first character is a chord instead
  const typed = text => {
    const [first, ...rest] = [...text];
    if (!first) return;
    if (sticky.current.some(mod => mod !== 'shift')) { chord(first === '+' ? 'plus' : first === ' ' ? 'space' : first); if (rest.length) viewer.type(rest.join('')); }
    else { viewer.type((sticky.current.includes('shift') ? first.toUpperCase() : first) + rest.join('')); setSticky([]); }
  };
  const press = key => {
    const mod = key.slice(1, -1);
    if (MODS.includes(mod)) setSticky(sticky.current.includes(mod) ? sticky.current.filter(m => m !== mod) : [...sticky.current, mod]);
    else if (NAMED[key]) chord(NAMED[key]);
    else typed(key === '{space}' ? ' ' : key);
  };
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
    viewer.releaseInput();
    if (document.pointerLockElement) document.exitPointerLock();
    document.querySelector('canvas.stage')?.focus({ preventScroll: true });
    return () => { el.removeEventListener('beforeinput', beforeInput); el.removeEventListener('compositionend', compositionEnd); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // a physical keyboard's keys that aren't text (and its modifier chords) go as chords; phone keyboards
  // report most keys as 229 and deliver them through beforeinput instead
  const onKeyDown = e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (KEYSYM[e.key]) { e.preventDefault(); chord(KEYSYM[e.key]); }
    else if ((e.ctrlKey || e.altKey || e.metaKey) && e.key.length === 1) { e.preventDefault(); viewer.key(`${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.metaKey ? 'super+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key === '+' ? 'plus' : e.key}`); }
  };
  return (
    <section aria-label="On-Screen Keyboard" className="border-t border-line bg-surface p-2 text-xs shadow-pop">
      <div className="mb-2 flex items-center gap-2">
        <input ref={field} data-keyboard="" onKeyDown={onKeyDown} onFocus={viewer.releaseInput}
          aria-label="Device keyboard / IME" title="Type Into Desktop" placeholder="Device keyboard / IME" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-md border border-line-2 bg-surface-2 px-2 text-ink outline-none focus:border-accent" />
        <IconButton icon={X} label="Hide Keyboard" size="sm" onClick={onClose} />
      </div>
      <SimpleKeyboard keyboardRef={instance => { keyboard.current = instance; }} layout={LAYOUT} layoutName={mods.includes('shift') ? 'shift' : 'default'} display={DISPLAY}
        theme="hg-theme-default elsewhere-keyboard" useButtonTag useMouseEvents preventMouseDownDefault disableButtonHold enableLayoutCandidates={false}
        buttonTheme={[{ class: 'osk-selected', buttons: mods.map(mod => `{${mod}}`).join(' ') }]}
        buttonAttributes={[...MODS.map(mod => ({ attribute: 'aria-pressed', value: String(mods.includes(mod)), buttons: `{${mod}}` })), ...Object.entries(NAMED).map(([buttons, name]) => ({ attribute: 'aria-label', value: name === 'BackSpace' ? 'Backspace' : name, buttons }))]}
        onKeyPress={press} onChange={() => keyboard.current?.clearInput()} />
    </section>
  );
}
