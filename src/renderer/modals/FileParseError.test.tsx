// @vitest-environment jsdom

import NiceModal from '@ebay/nice-modal-react'
import { MantineProvider } from '@mantine/core'
import { type ButtonHTMLAttributes, cloneElement, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@/test-utils'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn(
    (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })
  ),
})

Object.defineProperty(globalThis, 'ResizeObserver', {
  writable: true,
  value: class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})

const { mockNavigateToSettings, mockPlatform } = vi.hoisted(() => ({
  mockNavigateToSettings: vi.fn(),
  mockPlatform: { type: 'desktop', isDesktopLike: true },
}))

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey, components }: { i18nKey: string; components?: Record<string, ReactElement> }) => {
    const openSettingLabel = i18nKey.match(/<OpenSettingButton>(.*?)<\/OpenSettingButton>/)?.[1]
    const documentParserLabel = i18nKey.match(
      /<OpenDocumentParserSettingButton>(.*?)<\/OpenDocumentParserSettingButton>/
    )?.[1]
    return (
      <span>
        {i18nKey}
        {components?.OpenSettingButton && openSettingLabel
          ? cloneElement(components.OpenSettingButton, {}, openSettingLabel)
          : null}
        {components?.OpenDocumentParserSettingButton && documentParserLabel
          ? cloneElement(components.OpenDocumentParserSettingButton, {}, documentParserLabel)
          : null}
      </span>
    )
  },
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useScreenChange', () => ({
  useIsSmallScreen: () => false,
}))

vi.mock('@/components/common/AdaptiveModal', () => {
  const AdaptiveModal = ({ children, title }: { children: ReactNode; title?: ReactNode }) => (
    <div>
      <h2>{title}</h2>
      {children}
    </div>
  )
  AdaptiveModal.Actions = ({ children }: { children: ReactNode }) => <div>{children}</div>
  AdaptiveModal.CloseButton = (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {props.children ?? 'Cancel'}
    </button>
  )
  return { AdaptiveModal }
})

vi.mock('@/modals/settings-navigation', () => ({
  navigateToSettings: mockNavigateToSettings,
}))

vi.mock('@/packages/event', () => ({
  trackingEvent: vi.fn(),
}))

vi.mock('@/packages/remote', () => ({
  buildChatboxUrl: (path: string) => path,
}))

vi.mock('@/platform', () => ({
  default: Object.assign(mockPlatform, {
    openLink: vi.fn(),
  }),
}))

vi.mock('@/stores/settingActions', () => ({
  getLanguage: () => 'en',
}))

import FileParseError from './FileParseError'

const modalId = 'file-parse-error-test'
NiceModal.register(modalId, FileParseError)

function showFileParseError(errorCode: string, fileName?: string) {
  render(
    <MantineProvider>
      <NiceModal.Provider />
    </MantineProvider>
  )
  act(() => {
    void NiceModal.show(modalId, { errorCode, fileName })
  })
}

describe('FileParseError', () => {
  beforeEach(() => {
    mockNavigateToSettings.mockReset()
    mockPlatform.type = 'desktop'
    mockPlatform.isDesktopLike = true
  })

  test.each(['desktop', 'web', 'mobile'])(
    'guides %s users with legacy service errors to configured providers',
    async (type) => {
      mockPlatform.type = type
      mockPlatform.isDesktopLike = type === 'desktop'
      showFileParseError('chatbox_ai_parser_license_key_required', 'lecture.pdf')

      expect(await screen.findByText('File: lecture.pdf')).toBeTruthy()
      const openSettings = screen.getByRole('button', { name: 'settings' })
      expect(screen.queryByText('Sign in to Chatbox AI')).toBeNull()
      expect(document.querySelector('a[href*="chatboxai"]')).toBeNull()

      fireEvent.click(openSettings)

      expect(mockNavigateToSettings).toHaveBeenCalledWith('/provider')
    }
  )

  test('preserves the local password-protected PDF error', async () => {
    showFileParseError('pdf_password_protected', 'protected.pdf')

    expect(await screen.findByText('File: protected.pdf')).toBeTruthy()
    expect(
      screen.getByText('This PDF is password-protected, so its content cannot be read. Remove the password and upload it again.')
    ).toBeTruthy()
  })

  test('keeps document parser settings available for parser failures', async () => {
    showFileParseError('third_party_parser_failed', 'lecture.pdf')

    expect(await screen.findByText('File: lecture.pdf')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'document parser settings' }))

    expect(mockNavigateToSettings).toHaveBeenCalledWith('/document-parser')
  })
})
