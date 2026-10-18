// Every material can be entered in one of three units; the app always
// stores the canonical amount in kg, converting to/from whatever unit the
// person typing chose. "box" needs the product's own box_weight_grams —
// without it, box isn't a valid choice for that specific material.
export const UNITS = [
  { value: 'kg', label: 'كغ' },
  { value: 'g', label: 'غ' },
  { value: 'box', label: 'علبة' },
];

export function unitLabel(unit) {
  return UNITS.find((u) => u.value === unit)?.label || unit;
}

export function toKg(qty, unit, boxWeightGrams) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return null;
  if (unit === 'kg') return n;
  if (unit === 'g') return n / 1000;
  if (unit === 'box') {
    if (!boxWeightGrams) return null;
    return (n * boxWeightGrams) / 1000;
  }
  return null;
}

export function fromKg(qtyKg, unit, boxWeightGrams) {
  const n = Number(qtyKg);
  if (!Number.isFinite(n)) return '';
  if (unit === 'kg') return n;
  if (unit === 'g') return n * 1000;
  if (unit === 'box') {
    if (!boxWeightGrams) return '';
    return (n * 1000) / boxWeightGrams;
  }
  return '';
}
