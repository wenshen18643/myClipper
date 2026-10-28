type Section = 'assistant' | 'keys'

let requested: Section | null = null

export function requestSettingsSection(section: Section): void {
  requested = section
}

export function takeSettingsSection(): Section | null {
  const section = requested
  requested = null
  return section
}
