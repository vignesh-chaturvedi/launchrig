import AsyncStorage from '@react-native-async-storage/async-storage'
import type { FixtureVariant } from '@/features/fixture/fixture-variant'

export const PROCESS_DEATH_JOURNAL_KEY = '@launchrig/fixture/process-death/v1'

export type ProcessDeathPhase = 'IN_FLIGHT' | 'RECOVERED_UNKNOWN'

export interface ProcessDeathJournal {
  schemaVersion: 1
  variant: FixtureVariant
  attemptId: string
  originProcessInstance: string
  phase: ProcessDeathPhase
}

export type ProcessDeathJournalReadResult =
  | { status: 'ABSENT' }
  | { status: 'CORRUPT' }
  | { status: 'VALID'; journal: ProcessDeathJournal }

export function createProcessInstance(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function parseProcessDeathJournal(value: string | null): ProcessDeathJournal | null {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<ProcessDeathJournal>
    if (
      parsed.schemaVersion !== 1 ||
      (parsed.variant !== 'broken' && parsed.variant !== 'fixed') ||
      typeof parsed.attemptId !== 'string' ||
      parsed.attemptId.length === 0 ||
      typeof parsed.originProcessInstance !== 'string' ||
      parsed.originProcessInstance.length === 0 ||
      (parsed.phase !== 'IN_FLIGHT' && parsed.phase !== 'RECOVERED_UNKNOWN')
    ) {
      return null
    }

    return parsed as ProcessDeathJournal
  } catch {
    return null
  }
}

export async function readProcessDeathJournal(): Promise<ProcessDeathJournalReadResult> {
  const value = await AsyncStorage.getItem(PROCESS_DEATH_JOURNAL_KEY)
  if (value === null) {
    return { status: 'ABSENT' }
  }

  const journal = parseProcessDeathJournal(value)
  return journal ? { status: 'VALID', journal } : { status: 'CORRUPT' }
}

export async function writeProcessDeathJournal(journal: ProcessDeathJournal): Promise<void> {
  await AsyncStorage.setItem(PROCESS_DEATH_JOURNAL_KEY, JSON.stringify(journal))
}

export async function clearProcessDeathJournal(): Promise<void> {
  await AsyncStorage.removeItem(PROCESS_DEATH_JOURNAL_KEY)
}

export async function repairProcessDeathJournal(): Promise<void> {
  await clearProcessDeathJournal()
  const remaining = await AsyncStorage.getItem(PROCESS_DEATH_JOURNAL_KEY)
  if (remaining !== null) {
    throw new Error('The process-death journal was not cleared')
  }
}
