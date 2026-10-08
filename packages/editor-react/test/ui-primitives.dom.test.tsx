// @vitest-environment jsdom
/**
 * Keyboard and ARIA contracts of the ui/ primitives. jsdom has no layout, so these assert roles,
 * names, states and key handling, not geometry.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  Badge, Button, Callout, Checkbox, Chip, Combobox, ConfirmDialog, Dialog, Drawer, Field, FileDrop, IconButton, Input, Kbd, Menu, NumberInput,
  Popover, RadioGroup, SegmentedControl, Select, Skeleton, StatusDot, Switch, Tab, TabList, TabPanel, Tabs, Textarea, Tooltip,
} from '../src/ui/index.ts';

beforeAll(() => {
  // the bits of the platform Radix pokes that jsdom lacks
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined,
  });
});
afterEach(cleanup);

const key = (el: Element, k: string, init: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(el, { key: k, ...init });
  fireEvent.keyUp(el, { key: k, ...init });
};

describe('Button and IconButton', () => {
  it('is a button that does not submit by default, and loading disables it and sets aria-busy', () => {
    const onClick = vi.fn();
    const { rerender } = render(<form><Button onClick={onClick}>Save</Button></form>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.getAttribute('type')).toBe('button');
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<form><Button loading onClick={onClick}>Save</Button></form>);
    const busy = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });

  it('carries variant and size as data attributes (the styles hang off them)', () => {
    render(<Button variant="danger" size="xs">Delete</Button>);
    const b = screen.getByRole('button', { name: 'Delete' });
    expect(b.dataset['variant']).toBe('danger');
    expect(b.dataset['size']).toBe('xs');
  });

  it('IconButton is named by its required label and shows it as a tooltip on keyboard focus', async () => {
    render(<IconButton label="Delete wire" shortcut="Del" icon={<svg aria-hidden />} />);
    const b = screen.getByRole('button', { name: 'Delete wire' });
    b.focus();
    fireEvent.focus(b);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Delete wire');
    expect(tip.textContent).toContain('Del');
  });

  it('IconButton reflects a toggle through aria-pressed', () => {
    render(<IconButton label="Pin" pressed icon={<svg aria-hidden />} />);
    expect(screen.getByRole('button', { name: 'Pin' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Field, Input, Textarea', () => {
  it('wires label, hint and error to the control and marks it invalid', () => {
    render(
      <Field label="Gauge" hint="AWG, 18 to 30" error="Out of range" help="American wire gauge" required>
        <Input defaultValue="40" />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Gauge' });
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');
    const described = (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['AWG, 18 to 30', 'Out of range']);
    expect(screen.getByRole('alert').textContent).toBe('Out of range');
  });

  it('the (?) is a labelled button that explains the field', async () => {
    render(<Field label="Pitch" help="Centre-to-centre spacing"><Input /></Field>);
    const help = screen.getByRole('button', { name: 'About Pitch' });
    help.focus();
    fireEvent.focus(help);
    expect((await screen.findByRole('tooltip')).textContent).toContain('Centre-to-centre');
  });

  it('a Textarea inside a Field is labelled too', () => {
    render(<Field label="Notes"><Textarea /></Field>);
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });
});

describe('NumberInput', () => {
  function Harness({ start = 10 as number | null, ...props }: { start?: number | null; min?: number; max?: number; step?: number }) {
    const [v, setV] = useState<number | null>(start);
    return (
      <>
        <NumberInput aria-label="Length" value={v} onChange={setV} unit="mm" {...props} />
        <output data-testid="out">{String(v)}</output>
      </>
    );
  }

  it('reads its unit as part of its description', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Length');
    const unit = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(unit?.textContent).toBe('mm');
  });

  it('ArrowUp and ArrowDown step, Shift steps by ten, and min/max clamp', () => {
    render(<Harness min={0} max={25} step={2} />);
    const input = screen.getByLabelText('Length');
    key(input, 'ArrowUp');
    expect(screen.getByTestId('out').textContent).toBe('12');
    key(input, 'ArrowDown', { shiftKey: true });
    expect(screen.getByTestId('out').textContent).toBe('0');
    key(input, 'ArrowUp', { shiftKey: true });
    key(input, 'ArrowUp', { shiftKey: true });
    expect(screen.getByTestId('out').textContent).toBe('25');
  });

  it('commits typed text on Enter, accepts a decimal comma, and empties to null', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3,5' } });
    key(input, 'Enter');
    expect(screen.getByTestId('out').textContent).toBe('3.5');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('out').textContent).toBe('null');
  });

  it('puts back the last good value when the text is not a number', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Length') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(input.value).toBe('10');
  });
});

describe('Select', () => {
  const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }, { value: 'c', label: 'Charlie', group: 'More' }];
  function Harness() {
    const [v, setV] = useState('a');
    return <Select aria-label="Letter" value={v} onValueChange={setV} options={options} />;
  }

  it('is a combobox button that opens with the keyboard, lists options, and picks with Enter', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: 'Letter' });
    expect(trigger.textContent).toContain('Alpha');
    trigger.focus();
    key(trigger, 'ArrowDown');
    const list = await screen.findByRole('listbox');
    const opts = within(list).getAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(opts[0]?.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(opts[0]));
    key(opts[0]!, 'ArrowDown');
    await waitFor(() => expect(document.activeElement).toBe(opts[1]));
    key(opts[1]!, 'Enter');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Letter' }).textContent).toContain('Bravo'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is labelled by its Field', () => {
    render(<Field label="Colour"><Select value="a" onValueChange={() => undefined} options={options} /></Field>);
    expect(screen.getByRole('combobox', { name: 'Colour' })).toBeTruthy();
  });
});

describe('Combobox', () => {
  const options = [{ value: 'red', label: 'Red', hint: 'R' }, { value: 'green', label: 'Green' }, { value: 'blue', label: 'Blue' }];
  function Harness({ create }: { create?: (t: string) => void }) {
    const [v, setV] = useState<string | null>(null);
    return <Combobox aria-label="Colour" options={options} value={v} onValueChange={setV} {...(create === undefined ? {} : { onCreate: create })} />;
  }

  it('filters as you type, moves with arrows (aria-activedescendant), picks with Enter, closes with Escape', async () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Colour' }) as HTMLInputElement;
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.focus(input);
    expect(await screen.findByRole('listbox')).toBeTruthy();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(input, { target: { value: 'r' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['RedR', 'Green']);
    key(input, 'ArrowDown');
    const active = input.getAttribute('aria-activedescendant');
    expect(document.getElementById(active ?? '')?.textContent).toBe('Green');
    key(input, 'Enter');
    await waitFor(() => expect(input.value).toBe('Green'));
    expect(input.getAttribute('aria-expanded')).toBe('false');

    fireEvent.focus(input);
    await screen.findByRole('listbox');
    key(input, 'Escape');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('offers Create for a query that matches nothing', async () => {
    const create = vi.fn();
    render(<Harness create={create} />);
    const input = screen.getByRole('combobox', { name: 'Colour' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'violet' } });
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(['Create “violet”']);
    key(input, 'Enter');
    expect(create).toHaveBeenCalledWith('violet');
  });

  it('says so when nothing matches and creation is off', async () => {
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Colour' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(await screen.findByText('No matches')).toBeTruthy();
  });
});

describe('Checkbox, RadioGroup, Switch, SegmentedControl', () => {
  it('Checkbox: Space toggles, indeterminate is aria-checked=mixed', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox checked={false} onCheckedChange={onChange} label="Shielded" />);
    const box = screen.getByRole('checkbox', { name: 'Shielded' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    box.focus();
    fireEvent.click(box); // Radix toggles on click; Space on a button fires click
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Checkbox checked="indeterminate" onCheckedChange={onChange} label="Shielded" />);
    expect(screen.getByRole('checkbox', { name: 'Shielded' }).getAttribute('aria-checked')).toBe('mixed');
  });

  it('Checkbox: clicking the label toggles it', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onCheckedChange={onChange} label="Twisted" />);
    fireEvent.click(screen.getByText('Twisted'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('RadioGroup: a radiogroup with one tab stop; arrows move the selection', async () => {
    function Harness() {
      const [v, setV] = useState('a');
      return <RadioGroup aria-label="Side" value={v} onValueChange={setV} options={[{ value: 'a', label: 'Source' }, { value: 'b', label: 'Destination' }, { value: 'c', label: 'Both' }]} />;
    }
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Side' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    radios[0]!.focus();
    await waitFor(() => expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']));
    fireEvent.keyDown(radios[0]!, { key: 'ArrowDown' }); // keyup would clear Radix's arrow-key flag before the focus handler reads it
    await waitFor(() => expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']));
  });

  it('Switch: role switch, Space/click flips aria-checked, label names it', () => {
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onCheckedChange={setOn} label="Autosave" />;
    }
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Autosave' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(screen.getByRole('switch', { name: 'Autosave' }).getAttribute('aria-checked')).toBe('true');
  });

  it('SegmentedControl: radio semantics, arrow keys move focus, the selection cannot be cleared', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [v, setV] = useState('build');
      return <SegmentedControl aria-label="View" value={v} onValueChange={(n) => { onChange(n); setV(n); }} options={[{ value: 'build', label: 'Build' }, { value: 'schematic', label: 'Schematic' }]} />;
    }
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'View' });
    const [build, schem] = within(group).getAllByRole('radio');
    expect(build?.getAttribute('aria-checked')).toBe('true');
    build!.focus();
    key(build!, 'ArrowRight');
    await waitFor(() => expect(document.activeElement).toBe(schem));
    fireEvent.click(build!);
    fireEvent.click(build!); // pressing the selected one again must not deselect
    expect(onChange).not.toHaveBeenCalledWith('');
    expect(within(group).getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });
});

describe('Tabs', () => {
  it('tablist with roving focus: arrows move and activate, panel is labelled by its tab', async () => {
    render(
      <Tabs defaultValue="one">
        <TabList aria-label="Sections">
          <Tab value="one">One</Tab>
          <Tab value="two">Two</Tab>
        </TabList>
        <TabPanel value="one">first</TabPanel>
        <TabPanel value="two">second</TabPanel>
      </Tabs>,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(screen.getByRole('tabpanel').textContent).toBe('first');
    tabs[0]!.focus();
    key(tabs[0]!, 'ArrowRight');
    await waitFor(() => expect(document.activeElement).toBe(tabs[1]));
    await waitFor(() => expect(screen.getByRole('tabpanel').textContent).toBe('second'));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tabs[1]?.id);
  });
});

describe('Chip, Badge, StatusDot, Kbd, Skeleton', () => {
  it('a removable Chip has a named remove button', () => {
    const onRemove = vi.fn();
    render(<Chip onRemove={onRemove}>shielded</Chip>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove shielded' }));
    expect(onRemove).toHaveBeenCalled();
  });

  it('StatusDot is an image with a text name (colour is never the only signal)', () => {
    render(<StatusDot tone="err" label="Locked by Sam" />);
    expect(screen.getByRole('img', { name: 'Locked by Sam' })).toBeTruthy();
  });

  it('Badge, Kbd and Skeleton render; Skeleton is hidden from assistive tech', () => {
    const { container } = render(<><Badge tone="info">3</Badge><Kbd>K</Kbd><Skeleton width={40} /></>);
    expect(container.querySelector('kbd')?.textContent).toBe('K');
    expect(container.querySelector('.cs-ui-skeleton')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('3').dataset['tone']).toBe('info');
  });
});

describe('Tooltip', () => {
  it('opens on focus, and Escape closes it', async () => {
    render(<Tooltip content="Explains it"><button type="button">Target</button></Tooltip>);
    const target = screen.getByRole('button', { name: 'Target' });
    target.focus();
    fireEvent.focus(target);
    await screen.findByRole('tooltip');
    key(document.activeElement ?? target, 'Escape');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});

describe('Popover', () => {
  it('opens from its trigger (aria-expanded), Escape closes it and returns focus to the trigger', async () => {
    render(<Popover trigger={<Button>Filter</Button>} aria-label="Filter options"><Input aria-label="Query" /></Popover>);
    const trigger = screen.getByRole('button', { name: 'Filter' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.focus();
    fireEvent.click(trigger);
    const panel = await screen.findByRole('dialog', { name: 'Filter options' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(within(panel).getByLabelText('Query')).toBeTruthy();
    key(panel, 'Escape');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Menu', () => {
  it('opens with the keyboard, runs the highlighted item on Enter, skips disabled ones, and closes', async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    render(
      <Menu
        trigger={<Button>Actions</Button>}
        items={[
          { label: 'Rename', onSelect: onRename, shortcut: 'F2' },
          { label: 'Archive', onSelect: () => undefined, disabled: true },
          { type: 'separator' },
          { label: 'Delete', onSelect: onDelete, danger: true },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    key(trigger, 'ArrowDown');
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['RenameF2', 'Archive', 'Delete']);
    expect(items[1]?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(items[0]);
    key(items[0]!, 'Enter');
    expect(onRename).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('Escape closes it', async () => {
    render(<Menu trigger={<Button>Actions</Button>} items={[{ label: 'One', onSelect: () => undefined }]} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    trigger.focus();
    key(trigger, 'Enter');
    const menu = await screen.findByRole('menu');
    key(menu, 'Escape');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

describe('Dialog, ConfirmDialog, Drawer', () => {
  it('Dialog: modal, named by its title, described, Escape closes', async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Rename design" description="Pick a name" footer={<Button>Save</Button>}>
        <Input aria-label="Name" />
      </Dialog>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Rename design' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(dialog).getByLabelText('Name')).toBeTruthy();
    key(dialog, 'Escape');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Dialog: no description means no dangling aria-describedby', async () => {
    render(<Dialog open onOpenChange={() => undefined} title="Plain"><span>body</span></Dialog>);
    const dialog = await screen.findByRole('dialog', { name: 'Plain' });
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
  });

  it('ConfirmDialog: alertdialog, focus starts on Cancel, Escape cancels, the destructive button is danger', async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="Delete design?" destructive confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel}>This cannot be undone.</ConfirmDialog>);
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete design?' });
    expect(within(dialog).getByRole('button', { name: 'Delete' }).dataset['variant']).toBe('danger');
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
    key(dialog, 'Escape');
    expect(onCancel).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('Drawer: a named dialog with a Close button', async () => {
    const onClose = vi.fn();
    render(<Drawer open title="Details" onClose={onClose}>body</Drawer>);
    const drawer = await screen.findByRole('dialog', { name: 'Details' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Callout', () => {
  it('errors and warnings are announced; info and ok are polite; Details is a disclosure', () => {
    render(
      <>
        <Callout tone="err" details="E_LOCK held by another session">Could not save</Callout>
        <Callout tone="warn">Check the pinout</Callout>
        <Callout>Imported 12 parts</Callout>
        <Callout tone="ok">Saved</Callout>
      </>,
    );
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual(['Could not saveDetailsE_LOCK held by another session', 'Check the pinout']);
    expect(screen.getAllByRole('status').map((a) => a.textContent)).toEqual(['Imported 12 parts', 'Saved']);
    expect(screen.getByText('Details').tagName).toBe('SUMMARY');
  });
});

describe('FileDrop', () => {
  const file = (name: string, type = '') => new File(['x'], name, { type });

  it('is a button that opens the file picker on click, and hands accepted files over', () => {
    const onFiles = vi.fn();
    const onReject = vi.fn();
    render(<FileDrop onFiles={onFiles} onReject={onReject} accept=".step,model/*" aria-label="Upload a model" />);
    const zone = screen.getByRole('button', { name: 'Upload a model' });
    const input = screen.getByTestId('filedrop-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(zone);
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [file('part.STEP'), file('notes.txt', 'text/plain')] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect((onFiles.mock.calls[0]?.[0] as File[]).map((f) => f.name)).toEqual(['part.STEP']);
    expect((onReject.mock.calls[0]?.[0] as File[]).map((f) => f.name)).toEqual(['notes.txt']);
  });

  it('takes a dropped file (one unless multiple) and flags the drag-over state', () => {
    const onFiles = vi.fn();
    render(<FileDrop onFiles={onFiles} aria-label="Drop" />);
    const zone = screen.getByRole('button', { name: 'Drop' });
    fireEvent.dragOver(zone);
    expect(zone.dataset['over']).toBe('true');
    fireEvent.drop(zone, { dataTransfer: { files: [file('a.png', 'image/png'), file('b.png', 'image/png')] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect((onFiles.mock.calls[0]?.[0] as File[]).length).toBe(1);
    expect(zone.dataset['over']).toBeUndefined();
  });

  it('is inert when disabled', () => {
    render(<FileDrop onFiles={() => undefined} disabled aria-label="Drop" />);
    expect((screen.getByRole('button', { name: 'Drop' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
