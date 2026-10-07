/** URL-addressable Settings sections, shared by the route parser and navigation. */
export const SETTINGS_SECTIONS = [
  { id: 'documents', label: 'Documents', description: 'Organisation, document text, fonts and drawing art.' },
  { id: 'engineering', label: 'Engineering', description: 'Test defaults and engineering parameters.' },
  { id: 'numbering', label: 'Part numbering', description: 'Part-number schemes and suggestions.' },
  { id: 'rules', label: 'Validation rules', description: 'Checks applied to cable designs.' },
  { id: 'authentication', label: 'Sign-in & accounts', description: 'Sign-in providers, access and account settings.' },
  { id: 'runtime', label: 'Runtime', description: 'Notifications, integrations, job limits and encrypted settings.' },
  { id: 'webhooks', label: 'Webhooks', description: 'Event deliveries to external services.' },
  { id: 'stores', label: 'Catalog stores', description: 'Catalog sources and trusted publishers.' },
  { id: 'modules', label: 'Code modules', description: 'Installed modules and their permissions.' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export function settingsSection(value: unknown): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === value)?.id;
}
