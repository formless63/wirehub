/**
 * WireHub's UI primitives: shadcn-style components on Radix, re-themed entirely with the WireHub
 * tokens (tokens.css) so they read as the "bench instrument" look: dense, hairlines, copper only for
 * the primary action / current / selection, blue focus. Gallery: `/dev/ui` in a dev build.
 * Modules may use them through the module API's React surface.
 */
export { cx } from './cx.ts';
export { PortalContainerContext } from './portal.ts';

export { Button, IconButton } from './Button.tsx';
export type { ButtonProps, ButtonVariant, ControlSize, IconButtonProps } from './Button.tsx';
export { Kbd } from './Kbd.tsx';
export { Field, HelpTip, Input, Textarea, useFieldProps } from './Field.tsx';
export type { FieldProps, InputProps, TextareaProps } from './Field.tsx';
export { NumberInput } from './NumberInput.tsx';
export type { NumberInputProps } from './NumberInput.tsx';
export { Select } from './Select.tsx';
export type { SelectOption, SelectProps } from './Select.tsx';
export { Combobox } from './Combobox.tsx';
export type { ComboboxOption, ComboboxProps } from './Combobox.tsx';
export { Checkbox, RadioGroup, SegmentedControl, Switch } from './Controls.tsx';
export type { CheckboxProps, RadioGroupProps, RadioOption, SegmentedControlProps, SegmentedOption, SwitchProps } from './Controls.tsx';
export { Tab, TabList, TabPanel, Tabs } from './Tabs.tsx';
export { Badge, Chip, StatusDot } from './Chip.tsx';
export type { ChipProps, Tone } from './Chip.tsx';
export { Tooltip } from './Tooltip.tsx';
export type { TooltipProps } from './Tooltip.tsx';
export { Dialog, Menu, Popover } from './Overlays.tsx';
export type { DialogProps, MenuEntry, MenuProps, PopoverProps } from './Overlays.tsx';
export { Callout, Skeleton } from './Feedback.tsx';
export type { CalloutProps, CalloutTone } from './Feedback.tsx';
export { WireHubToaster, notify } from './Toast.tsx';
export type { NotifyOptions } from './Toast.tsx';
export { FileDrop } from './FileDrop.tsx';
export type { FileDropProps } from './FileDrop.tsx';
export { BeamArt } from './BeamArt.tsx';

export { ConfirmDialog } from './ConfirmDialog.tsx';
export type { ConfirmDialogProps } from './ConfirmDialog.tsx';
export { Drawer } from './Drawer.tsx';
export type { DrawerProps } from './Drawer.tsx';

export { DataTable } from './DataTable.tsx';
export type { DataColumn, DataSort, DataTableProps } from './DataTable.tsx';
export { EmptyState, KeyValues, Page, PageBody, PageHeader, SidePanel, Toolbar } from './Page.tsx';
export type { EmptyStateProps, PageHeaderProps, SidePanelProps, ToolbarProps } from './Page.tsx';
export { FilterChip, FilterMenu } from './FilterChip.tsx';
export type { FilterGroup } from './FilterChip.tsx';

export { localPrefsBackend, readPref, setPrefsBackend, usePref, writePref } from './prefs.ts';
export type { PrefsBackend } from './prefs.ts';
