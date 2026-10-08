/** URL-addressable Settings sections, shared by the route parser and navigation. */
export const SETTINGS_SECTIONS = [
  { id: 'documents', label: 'Documents', description: 'Organisation, document text, fonts and drawing art.', help: "Who the documents are issued by. Leave a field empty to keep the generic text. A module that supplies its own title-block art takes precedence." },
  { id: 'engineering', label: 'Engineering', description: 'Test defaults and engineering parameters.' },
  { id: 'numbering', label: 'Part numbering', description: 'Part-number schemes and suggestions.' },
  { id: 'rules', label: 'Validation rules', description: 'Checks applied to designs.' },
  { id: 'authentication', label: 'Sign-in & accounts', description: 'Sign-in providers, access and account settings.' },
  { id: 'runtime', label: 'System', description: 'Notifications, integrations, job limits and encrypted settings.', help: "These settings apply at once, with no restart. A value the server's environment sets wins and is shown read-only. Where the database, the files, the ports and the install's secrets are stays on the server." },
  { id: 'webhooks', label: 'Webhooks', description: 'Event deliveries to external services.' },
  { id: 'stores', label: 'Catalog stores', description: 'Catalog sources and trusted publishers.', help: "Choose which stores supply modules and catalog packs to the Store page. Adding a store does not install anything. Anyone can host a store; WireHub does not check what a store lists. Each store's index must be signed with the key you give here." },
  { id: 'module-settings', label: 'Module settings', description: 'Credentials and options the installed modules declare.', help: "Secrets are kept encrypted with the hub's settings key and never shown again; a change applies at once, with no restart. A value the server's environment sets wins and is shown locked." },
  { id: 'modules', label: 'Code modules', description: 'Installed modules and their permissions.' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export function settingsSection(value: unknown): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === value)?.id;
}

/** The longer explanation a section keeps behind its `(?)`, when it has one beyond its one-line description. */
export function sectionHelp(section: (typeof SETTINGS_SECTIONS)[number]): string {
  return 'help' in section ? `${section.description} ${section.help}` : section.description;
}
