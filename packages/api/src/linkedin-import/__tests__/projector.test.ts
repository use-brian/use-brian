import { describe, expect, it } from 'vitest'

import { parseLinkedInCsv } from '../csv.js'
import { buildLinkedInProjection } from '../projector.js'
import type { ExternalIdentity } from '../types.js'

function ids(...values: string[]) {
  let index = 0
  return () => values[index++] ?? `generated-${index}`
}

describe('[COMP:brain/linkedin-import] conservative LinkedIn graph projection', () => {
  it('builds direct connection/employer/conversation edges without group or company cliques', () => {
    const profile = parseLinkedInCsv('Profile.csv', Buffer.from([
      'First Name,Last Name,Public Profile Url',
      'Brian,Lee,https://www.linkedin.com/in/brian/',
    ].join('\n')))
    const connections = parseLinkedInCsv('Connections.csv', Buffer.from([
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Ada,Lovelace,https://www.linkedin.com/in/ada,,Acme,Founder,01 Jan 2020',
      'Grace,Hopper,https://www.linkedin.com/in/grace,,Acme,Admiral,02 Feb 2021',
      ',,,,,,03 Mar 2022',
    ].join('\n')))
    const contacts = parseLinkedInCsv('ImportedContacts.csv', Buffer.from([
      'First Name,Last Name,Email Address,Phone Number',
      'Alan,Turing,alan@example.com,+44 20 1234 5678',
      'Alan,Turing,alan@example.com,+44 20 1234 5678',
    ].join('\n')))
    const messages = parseLinkedInCsv('messages.csv', Buffer.from([
      'CONVERSATION ID,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,CONTENT',
      'c1,Brian,https://www.linkedin.com/in/brian,Ada,https://www.linkedin.com/in/ada,2026-01-01,Hello',
      'c1,Ada,https://www.linkedin.com/in/ada,Brian,https://www.linkedin.com/in/brian,2026-01-02,Hi',
      'group,Brian,https://www.linkedin.com/in/brian,"Ada, Grace","https://www.linkedin.com/in/ada, https://www.linkedin.com/in/grace",2026-01-03,Team hello',
    ].join('\n')))

    const projection = buildLinkedInProjection({
      runId: 'run-1',
      archiveSha256: 'a'.repeat(64),
      selfEntityId: 'self',
      csvs: [profile, connections, contacts, messages],
      existingIdentities: [],
      idFactory: ids('ada', 'acme', 'grace', 'alan'),
    })

    expect(projection.entities.map((entity) => [entity.id, entity.kind, entity.displayName])).toEqual([
      ['ada', 'person', 'Ada Lovelace'],
      ['acme', 'company', 'Acme'],
      ['grace', 'person', 'Grace Hopper'],
      ['alan', 'person', 'Alan Turing'],
    ])
    expect(projection.edges.filter((edge) => edge.edgeType === 'connected_to')).toHaveLength(2)
    expect(projection.edges.filter((edge) => edge.edgeType === 'works_at')).toHaveLength(2)
    expect(projection.edges.filter((edge) => edge.edgeType === 'discussed_with')).toHaveLength(1)
    expect(projection.edges.find((edge) => edge.edgeType === 'discussed_with')?.attributes.message_count).toBe(2)
    expect(projection.edges).not.toContainEqual(expect.objectContaining({ sourceId: 'ada', targetId: 'grace' }))

    // Duplicate contact rows are both observations but resolve to one entity.
    const imported = projection.rowOutcomes.filter((outcome) => outcome.outcomeReason === 'imported_contact')
    expect(imported).toHaveLength(2)
    expect(imported[0].entityIds).toEqual(['alan'])
    expect(imported[1].entityIds).toEqual(['alan'])

    expect(projection.rowOutcomes).toContainEqual(expect.objectContaining({
      memberPath: 'Connections.csv',
      rowOrdinal: 4,
      outcome: 'unresolved',
      outcomeReason: 'no_identity_or_name',
    }))
    expect(projection.rowOutcomes).toContainEqual(expect.objectContaining({
      memberPath: 'messages.csv',
      rowOrdinal: 4,
      outcome: 'stored',
      outcomeReason: 'group_message_preserved_without_person_clique',
    }))
  })

  it('refuses to merge when exact URL and email point at different entities', () => {
    const connections = parseLinkedInCsv('Connections.csv', Buffer.from([
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Collision,Case,https://linkedin.com/in/collision,collision@example.com,,,01 Jan 2020',
    ].join('\n')))
    const existingIdentities: ExternalIdentity[] = [
      { kind: 'profile_url', normalizedValue: 'https://linkedin.com/in/collision', originalValue: '', entityId: 'person-url' },
      { kind: 'email', normalizedValue: 'collision@example.com', originalValue: '', entityId: 'person-email' },
    ]
    const projection = buildLinkedInProjection({
      runId: 'run-1',
      archiveSha256: 'b'.repeat(64),
      selfEntityId: 'self',
      csvs: [connections],
      existingIdentities,
      idFactory: ids('must-not-be-used'),
    })
    expect(projection.entities).toEqual([])
    expect(projection.edges).toEqual([])
    expect(projection.rowOutcomes[0]).toMatchObject({
      outcome: 'unresolved',
      outcomeReason: 'conflicting_strong_identities',
    })
  })

  it('infers self only from the single profile URL present in every message row', () => {
    const profile = parseLinkedInCsv('Profile.csv', Buffer.from('First Name,Last Name\nBrian,Lee'))
    const messages = parseLinkedInCsv('messages.csv', Buffer.from([
      'CONVERSATION ID,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,CONTENT',
      'c1,Brian,https://linkedin.com/in/self,Ada,https://linkedin.com/in/ada,2026-01-01,Hello',
      'c1,Ada,https://linkedin.com/in/ada,Brian,https://linkedin.com/in/self,2026-01-02,Hi',
      'c2,Brian,https://linkedin.com/in/self,Bob,https://linkedin.com/in/bob,2026-01-03,Hello',
    ].join('\n')))
    const projection = buildLinkedInProjection({
      runId: 'run-1',
      archiveSha256: 'd'.repeat(64),
      selfEntityId: 'self',
      csvs: [profile, messages],
      existingIdentities: [],
      idFactory: ids('ada', 'bob'),
    })
    expect(projection.identities).toContainEqual(expect.objectContaining({
      kind: 'profile_url',
      normalizedValue: 'https://linkedin.com/in/self',
      entityId: 'self',
    }))
    expect(projection.edges).toContainEqual(expect.objectContaining({
      sourceId: 'self', targetId: 'ada', edgeType: 'discussed_with',
    }))
  })

  it('keeps name-only imported-address-book rows unresolved instead of name-merging', () => {
    const contacts = parseLinkedInCsv('ImportedContacts.csv', Buffer.from([
      'First Name,Last Name,Email Address,Phone Number',
      'Sam,Lee,,',
      'Sam,Lee,,',
    ].join('\n')))
    const projection = buildLinkedInProjection({
      runId: 'run-1',
      archiveSha256: 'c'.repeat(64),
      selfEntityId: 'self',
      csvs: [contacts],
      existingIdentities: [],
      idFactory: ids('sam-1', 'sam-2'),
    })
    expect(projection.entities).toEqual([])
    expect(projection.identities).toEqual([])
    expect(projection.rowOutcomes).toEqual([
      expect.objectContaining({ outcome: 'unresolved', outcomeReason: 'no_stable_identity' }),
      expect.objectContaining({ outcome: 'unresolved', outcomeReason: 'no_stable_identity' }),
    ])
  })

  it('reuses an existing Brian person on exact email without creating a duplicate', () => {
    const contacts = parseLinkedInCsv('ImportedContacts.csv', Buffer.from([
      'First Name,Last Name,Email Address,Phone Number',
      'Ada,Lovelace,ADA@example.com,',
    ].join('\n')))
    const projection = buildLinkedInProjection({
      runId: 'run-1', archiveSha256: 'f'.repeat(64), selfEntityId: 'self',
      csvs: [contacts],
      existingIdentities: [{
        kind: 'email', normalizedValue: 'ada@example.com', originalValue: 'ada@example.com', entityId: 'existing-ada',
      }],
      idFactory: ids('must-not-create'),
    })
    expect(projection.entities).toEqual([])
    expect(projection.rowOutcomes[0]).toMatchObject({
      outcome: 'mapped', outcomeReason: 'imported_contact', entityIds: ['existing-ada'],
    })
  })

  it('leaves an exact identifier unresolved when existing people already conflict', () => {
    const contacts = parseLinkedInCsv('ImportedContacts.csv', Buffer.from([
      'First Name,Last Name,Email Address,Phone Number',
      'Collision,Case,collision@example.com,',
    ].join('\n')))
    const projection = buildLinkedInProjection({
      runId: 'run-1', archiveSha256: '1'.repeat(64), selfEntityId: 'self',
      csvs: [contacts],
      existingIdentities: [
        { kind: 'email', normalizedValue: 'collision@example.com', originalValue: '', entityId: 'person-a' },
        { kind: 'email', normalizedValue: 'collision@example.com', originalValue: '', entityId: 'person-b' },
      ],
      idFactory: ids('must-not-create'),
    })
    expect(projection.entities).toEqual([])
    expect(projection.rowOutcomes[0]).toMatchObject({
      outcome: 'unresolved', outcomeReason: 'conflicting_strong_identities',
    })
  })

  it('counts outbound sender-only rows through the one-to-one conversation participant', () => {
    const profile = parseLinkedInCsv('Profile.csv', Buffer.from([
      'First Name,Last Name,Public Profile Url',
      'Brian,Lee,https://linkedin.com/in/self',
    ].join('\n')))
    const messages = parseLinkedInCsv('messages.csv', Buffer.from([
      'CONVERSATION ID,FROM,SENDER PROFILE URL,TO,DATE,CONTENT',
      'c1,Brian,https://linkedin.com/in/self,Ada,2026-01-01,Hello',
      'c1,Ada,https://linkedin.com/in/ada,Brian,2026-01-02,Hi',
    ].join('\n')))
    const projection = buildLinkedInProjection({
      runId: 'run-1', archiveSha256: '2'.repeat(64), selfEntityId: 'self',
      csvs: [profile, messages], existingIdentities: [], idFactory: ids('ada'),
    })
    expect(projection.rowOutcomes.filter((row) => row.outcomeReason === 'one_to_one_message')).toHaveLength(2)
    expect(projection.edges).toContainEqual(expect.objectContaining({
      sourceId: 'self', targetId: 'ada', edgeType: 'discussed_with',
      attributes: expect.objectContaining({ message_count: 2, conversation_ids: ['c1'] }),
    }))
  })

  it('is identity-idempotent when a retry sees identities persisted by its first attempt', () => {
    const connections = parseLinkedInCsv('Connections.csv', Buffer.from([
      'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
      'Ada,Lovelace,https://linkedin.com/in/ada,,Acme,Founder,01 Jan 2020',
    ].join('\n')))
    const first = buildLinkedInProjection({
      runId: 'run-1', archiveSha256: 'e'.repeat(64), selfEntityId: 'self',
      csvs: [connections], existingIdentities: [], idFactory: ids('ada', 'acme'),
    })
    const retry = buildLinkedInProjection({
      runId: 'run-1', archiveSha256: 'e'.repeat(64), selfEntityId: 'self',
      csvs: [connections], existingIdentities: first.identities,
      idFactory: ids('must-not-create'),
    })
    expect(first.entities).toHaveLength(2)
    expect(retry.entities).toEqual([])
    expect(retry.edges.map((edge) => edge.edgeType).sort()).toEqual(['connected_to', 'works_at'])
  })
})
