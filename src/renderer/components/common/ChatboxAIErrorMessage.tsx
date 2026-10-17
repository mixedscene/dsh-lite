import { Link } from '@mui/material'
import type { FC } from 'react'
import { Trans } from 'react-i18next'
import { navigateToSettings } from '@/modals/settings-navigation'

interface ChatboxAIErrorMessageProps {
  errorCode: number
  model?: string
  trackingSource?: string
}

export const ChatboxAIErrorMessage: FC<ChatboxAIErrorMessageProps> = () => (
  <Trans
    i18nKey="This service is unavailable. Please select a configured provider in <OpenSettingButton>settings</OpenSettingButton>."
    components={{
      OpenSettingButton: (
        <Link component="button" type="button" onClick={() => navigateToSettings('/provider')} />
      ),
    }}
  />
)
