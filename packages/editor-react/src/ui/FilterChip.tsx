/** A filter chip: a dashed button that opens a checklist; solid copper-edged once something is chosen. `FilterMenu` folds several into one popover for narrow toolbars. */

import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import type { JSX } from 'react';

import { Checkbox } from './Controls.tsx';
import { cx } from './cx.ts';
import { Popover } from './Overlays.tsx';

export interface FilterGroup {
  label: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** what an option reads as (ids to short names); the value itself otherwise */
  optionLabel?: (value: string) => string;
}

function Checklist({ group }: { group: FilterGroup }): JSX.Element {
  const show = group.optionLabel ?? ((v: string) => v);
  if (group.options.length === 0) return <p className="cs-ui-filter-none">Nothing to filter by yet.</p>;
  return (
    <div role="group" aria-label={`${group.label} options`} className="cs-ui-filter-list">
      {group.options.map((option) => (
        <Checkbox
          key={option}
          className="cs-ui-filter-row"
          checked={group.selected.includes(option)}
          onCheckedChange={(on) => group.onChange(on ? [...group.selected, option] : group.selected.filter((v) => v !== option))}
          label={<span title={show(option) === option ? undefined : option}>{show(option)}</span>}
        />
      ))}
      {group.selected.length === 0 ? null : (
        <button type="button" className="cs-ui-filter-clear" onClick={() => group.onChange([])}>
          Clear
        </button>
      )}
    </div>
  );
}

export function FilterChip({ group }: { group: FilterGroup }): JSX.Element {
  const show = group.optionLabel ?? ((v: string) => v);
  const active = group.selected.length > 0;
  return (
    <Popover
      aria-label={`${group.label} filter`}
      trigger={
        <button type="button" title={`Filter by ${group.label.toLowerCase()}`} className={cx('cs-ui-filter-chip', active && 'is-active')}>
          {group.label}
          {active ? <strong>{group.selected.length === 1 ? show(group.selected[0] as string) : group.selected.length}</strong> : null}
          <IconChevronDown size={12} aria-hidden />
        </button>
      }
    >
      <Checklist group={group} />
    </Popover>
  );
}

export function FilterMenu({ groups }: { groups: readonly FilterGroup[] }): JSX.Element {
  const count = groups.reduce((n, g) => n + g.selected.length, 0);
  return (
    <Popover
      aria-label="Filters"
      trigger={
        <button type="button" title="Filters" className={cx('cs-ui-filter-chip', count > 0 && 'is-active')}>
          <IconFilter size={14} aria-hidden />
          Filters
          {count > 0 ? <strong>{count}</strong> : null}
          <IconChevronDown size={12} aria-hidden />
        </button>
      }
    >
      <div className="cs-ui-filter-groups">
        {groups.map((g) => (
          <div key={g.label}>
            <p className="cs-ui-filter-head">{g.label}</p>
            <Checklist group={g} />
          </div>
        ))}
      </div>
    </Popover>
  );
}
