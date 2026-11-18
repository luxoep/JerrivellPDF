// SPDX-License-Identifier: MIT OR Apache-2.0
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react';

export interface NumberDraftOptions { min: number; max: number; step?: number; precision?: number; resetKey?: string }
export function parseNumberDraft(input: string, final = false): number | null {
  const text = input.trim().replace(',', '.');
  const pattern = final ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/ : /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
  if (!pattern.test(text)) return null;
  const number = Number(text); return Number.isFinite(number) ? number : null;
}

/** Keep incomplete input local. Only valid numbers reach previews/native state. */
export function useNumberDraft(value: number, onValue: (value: number) => void, options: NumberDraftOptions) {
  const precision = options.precision ?? 2;
  const format = (number: number) => String(Number(number.toFixed(precision)));
  const [draft, setDraft] = useState(() => format(value));
  const focused = useRef(false), emitted = useRef(value), resetKey = useRef(options.resetKey);
  const latest = useRef({ value, onValue, options }); latest.current = { value, onValue, options };
  useEffect(() => {
    if (resetKey.current !== options.resetKey || !focused.current || value !== emitted.current) {
      resetKey.current = options.resetKey; emitted.current = value; setDraft(format(value));
    }
  }, [value, options.resetKey, precision]);
  const publish = (next: number) => { if (next !== emitted.current) { emitted.current = next; latest.current.onValue(next); } };
  const finish = (input: string) => {
    const parsed = parseNumberDraft(input, true), { value: current, options: limits } = latest.current;
    const next = parsed === null ? current : Math.max(limits.min, Math.min(limits.max, parsed));
    focused.current = false; setDraft(format(next)); publish(next); return next;
  };
  const parsed = parseNumberDraft(draft);
  return {
    type: 'text' as const, inputMode: 'decimal' as const, role: 'spinbutton', value: draft,
    'aria-valuemin': options.min, 'aria-valuemax': options.max,
    'aria-valuenow': parsed === null ? value : parsed,
    'aria-invalid': Boolean(draft.trim() && (parsed === null ? !/^[+-]?(?:\d+)?[.,]?$/.test(draft.trim()) : parsed < options.min || parsed > options.max)),
    onFocus: (_event: FocusEvent<HTMLInputElement>) => { focused.current = true; },
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.target.value; focused.current = true; setDraft(input);
      const next = parseNumberDraft(input);
      if (next !== null && next >= options.min && next <= options.max) publish(next);
    },
    onBlur: (event: FocusEvent<HTMLInputElement>) => { finish(event.currentTarget.value); },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); emitted.current = latest.current.value; setDraft(format(latest.current.value));
      } else if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation(); finish(event.currentTarget.value); event.currentTarget.blur();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault(); event.stopPropagation();
        const current = parseNumberDraft(event.currentTarget.value, true) ?? latest.current.value;
        const step = (options.step ?? 1) * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
        const next = Number(Math.max(options.min, Math.min(options.max, current + step)).toFixed(precision));
        setDraft(format(next)); publish(next);
      }
    },
  };
}
