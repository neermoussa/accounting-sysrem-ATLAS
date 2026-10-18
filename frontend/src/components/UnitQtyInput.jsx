import { useState } from 'react';
import { UNITS, toKg, fromKg } from '../lib/units.js';

function formatNum(n) {
  if (n === '' || n === null || n === undefined || !Number.isFinite(n)) return '';
  // Trims float noise from box-weight division without forcing a fixed
  // decimal count that would round away a deliberately precise entry.
  return String(Math.round(n * 1000) / 1000);
}

// Quantity + unit selector pair. Keeps its own "what's currently typed, in
// which unit" state locally rather than re-deriving from valueKg on every
// keystroke (that round-trip — kg -> unit -> kg -> unit — would fight the
// user mid-type, same reasoning as the plain qty input in QuickOrderForm).
// A parent that reloads server data should remount this via a changed
// `key` if it wants the display to pick up an externally-changed value.
// onChangeEntered (optional) additionally reports the raw as-typed number
// and unit — useful for callers (order entry) that want to remember and
// redisplay "5 علبة" later instead of only the converted kg figure.
export default function UnitQtyInput({
  valueKg,
  onChangeKg,
  onChangeEntered,
  boxWeightGrams,
  disabled,
  id,
  showStepper,
  initialUnit = 'kg',
}) {
  const [unit, setUnit] = useState(initialUnit);
  const [text, setText] = useState(() => formatNum(fromKg(valueKg, initialUnit, boxWeightGrams)));

  function handleUnitChange(nextUnit) {
    setUnit(nextUnit);
    const newText = formatNum(fromKg(valueKg, nextUnit, boxWeightGrams));
    setText(newText);
    onChangeEntered?.(Number(newText) || 0, nextUnit);
  }

  function handleTextChange(raw) {
    setText(raw);
    const kg = toKg(raw, unit, boxWeightGrams);
    if (kg !== null) onChangeKg(kg);
    onChangeEntered?.(Number(raw) || 0, unit);
  }

  function adjust(delta) {
    const current = Number(text) || 0;
    handleTextChange(String(Math.max(0, current + delta)));
  }

  return (
    <div className="unit-qty-input">
      {showStepper && (
        <button type="button" onClick={() => adjust(-1)} disabled={disabled}>
          −
        </button>
      )}
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onChange={(e) => handleTextChange(e.target.value)}
        onFocus={(e) => e.target.select()}
      />
      {showStepper && (
        <button type="button" onClick={() => adjust(1)} disabled={disabled}>
          +
        </button>
      )}
      <select value={unit} disabled={disabled} onChange={(e) => handleUnitChange(e.target.value)}>
        {UNITS.map((u) => (
          <option key={u.value} value={u.value} disabled={u.value === 'box' && !boxWeightGrams}>
            {u.label}
          </option>
        ))}
      </select>
    </div>
  );
}
