import { chatTierDefaults, registryRow } from '@use-brian/shared/model-registry'

const row = registryRow(chatTierDefaults().standard)
if (row?.provider !== 'gemini' || row.status !== 'active') {
  throw new Error('The Gemini Standard journey requires an active Gemini Standard model')
}

export const standardGemini = row
