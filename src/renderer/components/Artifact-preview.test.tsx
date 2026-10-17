// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/stores/session/generation', () => ({ getMessageThreadContext: vi.fn(async () => []) }))
vi.mock('@/hooks/useScreenChange', () => ({ useIsSmallScreen: () => false }))
vi.mock('@/platform', () => ({ default: { type: 'desktop', appLog: vi.fn(async () => undefined) } }))

import { Artifact } from './Artifact'

const completeHtml = `<!DOCTYPE html>
<html>
<head><style>body { background: rebeccapurple; }</style></head>
<body>
<form><input name="example" /></form>
<canvas id="game"></canvas>
<script>window.exampleRuns = (window.exampleRuns || 0) + 1;</script>
</body>
</html>`

function iframe(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector('iframe')
  expect(frame).not.toBeNull()
  return frame as HTMLIFrameElement
}

describe('Artifact', () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('loads complete HTML locally, including styles, scripts and forms, in an opaque sandbox', () => {
    const { container } = render(<Artifact htmlCode={completeHtml} />)
    const frame = iframe(container)

    expect(frame.getAttribute('srcdoc')).toBe(completeHtml)
    expect(frame.hasAttribute('src')).toBe(false)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    expect(frame.classList.contains('h-[400px]')).toBe(true)
  })

  it('applies the latest streamed document and cancels superseded updates', () => {
    const { container, rerender } = render(<Artifact htmlCode="<p>initial</p>" />)
    const frame = iframe(container)

    rerender(<Artifact htmlCode="<p>superseded</p>" />)
    act(() => vi.advanceTimersByTime(200))
    rerender(<Artifact htmlCode={completeHtml} />)
    act(() => vi.advanceTimersByTime(200))
    expect(frame.getAttribute('srcdoc')).toBe('<p>initial</p>')
    act(() => vi.advanceTimersByTime(100))
    expect(iframe(container)).toBe(frame)
    expect(frame.getAttribute('srcdoc')).toBe(completeHtml)

    rerender(<Artifact htmlCode="<p>another update</p>" />)
    act(() => vi.advanceTimersByTime(300))
    expect(frame.getAttribute('srcdoc')).toBe('<p>another update</p>')
  })

  it('recreates the local frame for each replay even when the HTML is unchanged', () => {
    const { container, rerender } = render(<Artifact htmlCode={completeHtml} reloadSign={0} />)
    const firstFrame = iframe(container)

    rerender(<Artifact htmlCode={completeHtml} reloadSign={1} />)
    const secondFrame = iframe(container)
    expect(secondFrame).not.toBe(firstFrame)
    expect(secondFrame.getAttribute('srcdoc')).toBe(completeHtml)

    rerender(<Artifact htmlCode={completeHtml} reloadSign={2} />)
    expect(iframe(container)).not.toBe(secondFrame)
    expect(iframe(container).getAttribute('srcdoc')).toBe(completeHtml)
  })

  it('preserves explicit preview URLs and their sandbox behavior on updates and reload', () => {
    const previewUrl = 'https://preview.example.test/page'
    const { container, rerender } = render(<Artifact htmlCode={completeHtml} previewUrl={previewUrl} reloadSign={0} />)
    const firstFrame = iframe(container)

    expect(firstFrame.getAttribute('src')).toBe(previewUrl)
    expect(firstFrame.hasAttribute('srcdoc')).toBe(false)
    expect(firstFrame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin')

    rerender(<Artifact htmlCode="<p>local change</p>" previewUrl={previewUrl} reloadSign={0} />)
    act(() => vi.advanceTimersByTime(500))
    expect(iframe(container)).toBe(firstFrame)
    expect(firstFrame.hasAttribute('srcdoc')).toBe(false)

    rerender(<Artifact htmlCode={completeHtml} previewUrl={previewUrl} reloadSign={1} />)
    expect(iframe(container)).not.toBe(firstFrame)
    expect(iframe(container).getAttribute('src')).toBe(previewUrl)
    expect(iframe(container).hasAttribute('srcdoc')).toBe(false)
  })

  it('switches back from a URL to the current local document and retains resize classes', () => {
    const { container, rerender } = render(
      <Artifact htmlCode="<p>old local document</p>" previewUrl="https://preview.example.test/page" className="flex-1" />
    )

    rerender(<Artifact htmlCode={completeHtml} className="flex-1 h-[600px]" />)
    act(() => vi.advanceTimersByTime(300))
    const frame = iframe(container)
    expect(frame.hasAttribute('src')).toBe(false)
    expect(frame.getAttribute('srcdoc')).toBe(completeHtml)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    expect(frame.classList.contains('flex-1')).toBe(true)
    expect(frame.classList.contains('h-[600px]')).toBe(true)

    rerender(<Artifact htmlCode={completeHtml} className="flex-1 h-[700px]" />)
    expect(iframe(container)).toBe(frame)
    expect(frame.classList.contains('h-[700px]')).toBe(true)
  })

  it('cancels pending document updates when unmounted', () => {
    const { rerender, unmount } = render(<Artifact htmlCode="<p>initial</p>" />)
    rerender(<Artifact htmlCode={completeHtml} />)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
