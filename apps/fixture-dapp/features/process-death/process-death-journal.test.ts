import { describe, expect, it } from 'vitest'
import { parseProcessDeathJournal } from '@/features/process-death/process-death-journal'

describe('parseProcessDeathJournal', () => {
  it('accepts the versioned journal without exposing identifiers to the UI', () => {
    expect(
      parseProcessDeathJournal(
        JSON.stringify({
          schemaVersion: 1,
          variant: 'fixed',
          attemptId: 'attempt',
          originProcessInstance: 'process',
          phase: 'IN_FLIGHT',
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      variant: 'fixed',
      attemptId: 'attempt',
      originProcessInstance: 'process',
      phase: 'IN_FLIGHT',
    })
  })

  it('rejects malformed or unsupported journals', () => {
    expect(parseProcessDeathJournal(null)).toBeNull()
    expect(parseProcessDeathJournal('not-json')).toBeNull()
    expect(parseProcessDeathJournal(JSON.stringify({ schemaVersion: 2 }))).toBeNull()
  })
})
