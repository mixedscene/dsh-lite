import { Button, Modal, Stack, Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import { useDbSchemaGuardStore } from '@/storage/db-schema-guard'

/** Preserve the blocking database guards without contacting an update service. */
export default function DbSchemaGuardDialog() {
  const { t } = useTranslation()
  const schemaTooNewDbName = useDbSchemaGuardStore((s) => s.schemaTooNewDbName)
  const upgradedElsewhereDbName = useDbSchemaGuardStore((s) => s.upgradedElsewhereDbName)
  const upgradeBlockedDbName = useDbSchemaGuardStore((s) => s.upgradeBlockedDbName)

  if (schemaTooNewDbName) {
    return (
      <Modal opened onClose={() => {}} withCloseButton={false} closeOnClickOutside={false} closeOnEscape={false}
        centered title={t('Your data was created by a newer version of Chatbox')}>
        <Stack gap="sm">
          <Text size="sm">{t('This version of Chatbox cannot read data created by a newer version. Your data is safe — update Chatbox to the latest version to continue.')}</Text>
          <Button onClick={() => window.location.reload()}>{t('Reload')}</Button>
        </Stack>
      </Modal>
    )
  }
  if (upgradeBlockedDbName) {
    return (
      <Modal opened onClose={() => {}} withCloseButton={false} closeOnClickOutside={false} closeOnEscape={false}
        centered title={t('Waiting for other Chatbox windows')}>
        <Text size="sm">{t('Close other Chatbox windows or tabs to finish updating the local database.')}</Text>
      </Modal>
    )
  }
  if (upgradedElsewhereDbName) {
    return (
      <Modal opened onClose={() => {}} withCloseButton={false} closeOnClickOutside={false} closeOnEscape={false}
        centered title={t('Chatbox was updated in another window')}>
        <Stack gap="sm">
          <Text size="sm">{t('Reload this page to continue.')}</Text>
          <Button onClick={() => window.location.reload()}>{t('Reload')}</Button>
        </Stack>
      </Modal>
    )
  }
  return null
}
