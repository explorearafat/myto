import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { QuestionBar } from '@renderer/components/ChatPanel'
import type { PendingQuestion } from '@shared/types'

/**
 * #1 — the clarifying-question bar. When the model emits `ask_user` the run blocks
 * and this bar appears; the user answers by clicking a suggested option or typing
 * their own, and the answer is fed back so the run resumes. These pin that the bar
 * renders the question (with its options as suggestions, not a closed set) and that
 * every path to an answer — chip click, Send button, Enter key — reports it back.
 */
const withOptions: PendingQuestion = {
  id: 'q-1',
  question: 'Which auth should I wire up?',
  header: 'Auth method',
  options: ['Email + password', 'Google']
}

describe('QuestionBar', () => {
  it('renders the header, question, and each option as a chip', () => {
    render(<QuestionBar question={withOptions} onAnswer={() => {}} />)
    expect(screen.getByText('Auth method')).toBeTruthy()
    expect(screen.getByText('Which auth should I wire up?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Email + password' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Google' })).toBeTruthy()
  })

  it('falls back to a generic header when none is given', () => {
    render(<QuestionBar question={{ id: 'q-2', question: 'Ship it?' }} onAnswer={() => {}} />)
    expect(screen.getByText('A quick question')).toBeTruthy()
  })

  it('answers with the option text when a chip is clicked', () => {
    const onAnswer = vi.fn()
    render(<QuestionBar question={withOptions} onAnswer={onAnswer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Google' }))
    expect(onAnswer).toHaveBeenCalledWith('Google')
  })

  it('answers with the typed text (trimmed) via the Send button', () => {
    const onAnswer = vi.fn()
    render(<QuestionBar question={withOptions} onAnswer={onAnswer} />)
    const input = screen.getByPlaceholderText('Or type your own answer…')
    fireEvent.change(input, { target: { value: '  magic links  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onAnswer).toHaveBeenCalledWith('magic links')
  })

  it('answers on Enter in the input', () => {
    const onAnswer = vi.fn()
    render(<QuestionBar question={withOptions} onAnswer={onAnswer} />)
    const input = screen.getByPlaceholderText('Or type your own answer…')
    fireEvent.change(input, { target: { value: 'passkeys' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith('passkeys')
  })

  it('does not answer on empty or whitespace-only input', () => {
    const onAnswer = vi.fn()
    render(<QuestionBar question={withOptions} onAnswer={onAnswer} />)
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    const input = screen.getByPlaceholderText('Or type your own answer…')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('uses a plain placeholder when there are no options', () => {
    render(<QuestionBar question={{ id: 'q-3', question: 'What name?' }} onAnswer={() => {}} />)
    expect(screen.getByPlaceholderText('Type your answer…')).toBeTruthy()
  })
})
