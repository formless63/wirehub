/** URL-addressable Settings sections, shared by the route parser and navigation. */
export const SETTINGS_SECTIONS = [
  { id: 'documents', label: 'Documents', description: 'Organisation, document text, fonts and drawing art.', help: "Who the documents are issued by. Leave a field empty to keep the generic text. A module that supplies its own title-block art takes precedence." },
  { id: 'engineering', label: 'Engineering', description: 'Test defaults and engineering parameters.' },
  { id: 'numbering', label: 'Part numbering', description: 'Part-number schemes and suggestions.' },
  { id: 'rules', label: 'Validation rules', description: 'Checks applied to designs.', help: 'Checks written as data: what each rule is about, which of those it applies to, what must hold, a severity and a message. They run with the built-in checks, so they show in each design’s issues panel, and an error blocks a save. No code runs; complex cases stay code rules in a module.' },
  { id: 'processes', label: 'Processes', description: 'Manufacturing processes designs need.', help: 'A design declares the ones it needs; a process with a "derived when" condition is added to every design it matches. Saved versions keep the list they were saved with.' },
  { id: 'authentication', label: 'Sign-in & accounts', description: 'Sign-in providers, access and account settings.', help: 'Whether sign-in is on at all (AUTH_ENABLED), the public address and the session secret are install settings and stay on the server. A save reloads the sign-in at once; people already signed in stay signed in.' },
  { id: 'people', label: 'People', description: 'Who can sign in to this hub, and their roles.' },
  { id: 'runtime', label: 'System', description: 'Integrations, job limits and the settings key.', help: "These settings apply at once, with no restart. A value the server's environment sets wins and is shown read-only. Where the database, the files, the ports and the install's secrets are stays on the server." },
  { id: 'webhooks', label: 'Webhooks & alerts', description: 'Events and the hub’s own alerts, posted to outside services.' },
  // shown beside each module in Extensions › Installed; the address still opens it here
  { id: 'module-settings', label: 'Module settings', nav: false, description: 'Credentials and options the installed modules declare.', help: "Secrets are kept encrypted with the hub's settings key and never shown again; a change applies at once, with no restart. A value the server's environment sets wins and is shown locked." },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];
export function settingsSection(value: unknown): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === value)?.id;
}

/** The longer explanation a section keeps behind its `(?)`, when it has one beyond its one-line description. */
/** Whether a section is listed in the Settings navigation (Module settings lives in Extensions). */
export const inSettingsNav = (section: (typeof SETTINGS_SECTIONS)[number]): boolean => !('nav' in section) || section.nav !== false;

export function sectionHelp(section: (typeof SETTINGS_SECTIONS)[number]): string {
  return 'help' in section ? `${section.description} ${section.help}` : section.description;
}
