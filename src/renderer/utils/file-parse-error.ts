import { featureFlags } from '@/utils/feature-flags'
import { CHATBOX_AI_PARSER_LICENSE_KEY_REQUIRED_ERROR } from '@shared/file-parse-errors'
import { ChatboxAIAPIError } from '@shared/models/errors'

export const CHATBOX_AI_PARSER_SIGN_IN_ONLY_I18N_KEY =
  '<OpenSettingButton>Sign in to Chatbox AI</OpenSettingButton> to use your account license.'

export function getFileParseErrorI18nKey(errorCode: string, isDesktopLike: boolean): string | undefined {
  if (!featureFlags.chatboxAI && ChatboxAIAPIError.codeNameMap[errorCode]) {
    return 'File parsing failed. Check your <OpenDocumentParserSettingButton>document parser settings</OpenDocumentParserSettingButton> or use a different file format.'
  }
  if (errorCode === CHATBOX_AI_PARSER_LICENSE_KEY_REQUIRED_ERROR && !isDesktopLike) {
    return CHATBOX_AI_PARSER_SIGN_IN_ONLY_I18N_KEY
  }
  return ChatboxAIAPIError.codeNameMap[errorCode]?.i18nKey
}
