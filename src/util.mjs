// Общие утилиты: ГПСЧ с сидом, сопоставление предметов с шаблонами входов операций.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x9e3779b9;
  }
  return h >>> 0;
}

const isUnset = (v) => v === null || v === undefined;

/** Подходит ли предмет под шаблон входа операции (раздел 3.1 спецификации). */
export function matchesTemplate(item, tmpl) {
  if (!item || !tmpl) return false;
  if (tmpl.kind && item.kind !== tmpl.kind) return false;
  const props = tmpl.props || {};
  const ip = item.props || {};
  for (const key of Object.keys(props)) {
    const want = props[key];
    const have = ip[key];
    if (want === null) {
      if (!isUnset(have)) return false;
    } else if (want === '*') {
      if (isUnset(have)) return false;
    } else if (have !== want) {
      return false;
    }
  }
  return true;
}

/** Свойства результата операции: наследование входа №inherit + output.props. */
export function resultProps(op, inputs) {
  const base = Number.isInteger(op.inherit) && inputs[op.inherit] ? { ...(inputs[op.inherit].props || {}) } : {};
  return { ...base, ...((op.output && op.output.props) || {}) };
}

export const round2 = (x) => Math.round(x * 100) / 100;

/** Ключ типа робота по атрибутам, например "red|true". */
export function typeKey(props, attrNames) {
  return attrNames.map((a) => String(props?.[a])).join('|');
}

/** Все комбинации значений атрибутов (типы роботов). */
export function allTypes(attributes) {
  const names = Object.keys(attributes);
  let combos = [{}];
  for (const n of names) {
    const next = [];
    for (const c of combos) for (const v of attributes[n]) next.push({ ...c, [n]: v });
    combos = next;
  }
  return { names, types: combos };
}
