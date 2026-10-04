/**
 * Find a pin: a SCART board is 22+ pads and a
 * bonded multi-core end 15 elements, so the canvas gets a search box. Type any part
 * of a terminal key or its label (`scart.20`, `csync`, `u2 GND`), pick with
 * the arrows and Enter; the host selects the terminal (its net lights) and
 * brings it into view.
 */

import { designInstances, terminalsOf, type CableDesign, type Db } from '@cable-studio/model';
import { IconSearch } from '@tabler/icons-react';
import { useMemo, useState, type JSX } from 'react';

import { classes } from '../context.ts';

export interface PinHit {
  key: string;
  label?: string;
}

/** Every terminal of the design, as `key` + label, in instance order. */
export function designPins(design: CableDesign, db: Db): PinHit[] {
  const out: PinHit[] = [];
  for (const instance of designInstances(design)) {
    for (const t of terminalsOf(design, db, instance.id)) {
      out.push({ key: t.key, ...(t.label === undefined ? {} : { label: t.label }) });
    }
  }
  return out;
}

/** The pins every whitespace-separated token of `query` appears in (key or label), best first. */
export function searchPins(pins: readonly PinHit[], query: string, limit = 12): PinHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return [];
  const scored: { pin: PinHit; score: number }[] = [];
  for (const pin of pins) {
    const key = pin.key.toLowerCase();
    const hay = `${key} ${(pin.label ?? '').toLowerCase()}`;
    if (!tokens.every((t) => hay.includes(t))) continue;
    // an exact terminal id beats a key prefix beats a label hit
    const last = tokens[tokens.length - 1] as string;
    const terminal = key.slice(key.indexOf(':') + 1).replace(/@[ab]$/, '');
    const score = terminal === last ? 0 : key.startsWith(tokens[0] as string) ? 1 : key.includes(last) ? 2 : 3;
    scored.push({ pin, score });
  }
  scored.sort((x, y) => x.score - y.score || (x.pin.key < y.pin.key ? -1 : x.pin.key > y.pin.key ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.pin);
}

export function PinSearch({
  design,
  db,
  onPick,
  onClose,
}: {
  design: CableDesign;
  db: Db;
  onPick: (key: string) => void;
  onClose: () => void;
}): JSX.Element {
  const pins = useMemo(() => designPins(design, db), [design, db]);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const hits = useMemo(() => searchPins(pins, query), [pins, query]);
  const pick = (hit: PinHit | undefined): void => {
    if (hit === undefined) return;
    onPick(hit.key);
    onClose();
  };
  return (
    <div className="cs-pin-search" role="dialog" aria-label="Find a pin">
      <div className="cs-pin-search-field">
        <IconSearch size={14} aria-hidden="true" />
        <input
          className="cs-input"
          autoFocus
          value={query}
          placeholder="pin, pad or wire…"
          aria-label="find a pin"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onBlur={(event) => {
            // a click on a result lands before the blur closes the box
            if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('.cs-pin-search'))) onClose();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
            else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((i) => Math.min(hits.length - 1, i + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (event.key === 'Enter') pick(hits[active]);
          }}
        />
      </div>
      {query.trim() === '' ? null : hits.length === 0 ? (
        <p className="cs-empty">no pin matches</p>
      ) : (
        <ul className="cs-pin-search-list" role="listbox" aria-label="pins">
          {hits.map((hit, i) => (
            <li key={hit.key}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={classes('cs-pin-search-hit', i === active && 'is-active')}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(hit)}
              >
                <span className="cs-mono">{hit.key}</span>
                {hit.label === undefined ? null : <span className="cs-pin-search-label">{hit.label}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
