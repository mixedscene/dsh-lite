// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import MessageMinimapRail, { getMinimapRenderRange, type MessageMinimapAnchor } from './MessageMinimapRail'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      Object.entries(values ?? {}).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), key),
  }),
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function createAnchors(count: number): MessageMinimapAnchor[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `message-${index + 1}`,
    itemIndex: index,
    text: `Message ${index + 1}`,
  }))
}

describe('getMinimapRenderRange', () => {
  test('renders only the visible start of a large minimap plus overscan', () => {
    const range = getMinimapRenderRange(1000, 0, 360)

    expect(range).toEqual({ start: 0, end: 38 })
    expect(range.end - range.start).toBeLessThan(50)
  })

  test('keeps a bounded window around the middle of the minimap', () => {
    const range = getMinimapRenderRange(1000, 6000, 360)

    expect(range).toEqual({ start: 492, end: 538 })
    expect(range.end - range.start).toBeLessThan(50)
  })

  test('includes the final anchor when scrolled to the bottom', () => {
    const range = getMinimapRenderRange(1000, 12_000 - 360, 360)

    expect(range).toEqual({ start: 962, end: 1000 })
  })

  test('uses a stable fallback window before layout is measured', () => {
    expect(getMinimapRenderRange(1000, 0, 0)).toEqual({ start: 0, end: 38 })
    expect(getMinimapRenderRange(0, 0, 0)).toEqual({ start: 0, end: 0 })
  })

  test('moves keyboard focus to anchors outside the rendered window', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    render(createElement(MessageMinimapRail, { anchors: createAnchors(100) }))

    const firstButton = screen.getByRole('button', { name: 'Jump to message 1' })
    firstButton.focus()
    expect(screen.getAllByRole('button').filter((button) => button.tabIndex === 0)).toEqual([firstButton])

    fireEvent.keyDown(firstButton, { key: 'End' })

    const lastButton = await screen.findByRole('button', { name: 'Jump to message 100' })
    await waitFor(() => expect(document.activeElement).toBe(lastButton))
    expect(screen.queryByRole('button', { name: 'Jump to message 1' })).toBeNull()
    expect(screen.getAllByRole('button').length).toBeLessThan(50)

    fireEvent.keyDown(lastButton, { key: 'ArrowUp' })
    const previousButton = screen.getByRole('button', { name: 'Jump to message 99' })
    await waitFor(() => expect(document.activeElement).toBe(previousButton))

    fireEvent.keyDown(previousButton, { key: 'Home' })

    const restoredFirstButton = await screen.findByRole('button', { name: 'Jump to message 1' })
    await waitFor(() => expect(document.activeElement).toBe(restoredFirstButton))
    expect(screen.queryByRole('button', { name: 'Jump to message 100' })).toBeNull()
  })
})
