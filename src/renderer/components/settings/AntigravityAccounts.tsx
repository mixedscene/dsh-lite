import { App } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { Button, Group, Select, Stack, Text } from '@mantine/core'
import { AntigravityClient } from '@shared/providers/antigravity/client'
import { antigravityNative, createNativeAntigravityTransport, type AntigravityAccount } from '@shared/providers/antigravity/native'
import type { ProviderModelInfo } from '@shared/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { settingsStore } from '@/stores/settingsStore'

const client = new AntigravityClient(createNativeAntigravityTransport())
type AccountState = Awaited<ReturnType<typeof antigravityNative.listAccounts>>

function cachedModels(account?: AntigravityAccount): ProviderModelInfo[] {
  return Array.isArray(account?.modelCache) ? account.modelCache.filter((model): model is ProviderModelInfo =>
    !!model && typeof model === 'object' && typeof model.modelId === 'string' && model.modelId.length > 0) : []
}
function setModels(models: ProviderModelInfo[]) {
  const state = settingsStore.getState()
  state.setSettings({ providers: { ...state.providers, antigravity: { ...state.providers?.antigravity, models } } })
}

/** Original provider settings controls; credentials stay in the existing native store. */
export function AntigravityAccounts({ onAccountChange }: { onAccountChange?: () => void }) {
  const { t } = useTranslation()
  const [state, setState] = useState<AccountState>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(false)
  const previousAccount = useRef<string | undefined | null>(null)
  const callback = useRef(onAccountChange)
  callback.current = onAccountChange
  const refresh = useCallback(async () => {
    const next = await antigravityNative.listAccounts()
    if (!mounted.current) return next
    setState(next)
    if (next.storageError || next.oauthError) setError(next.storageError || next.oauthError || '')
    if (previousAccount.current !== next.activeAccountId) {
      previousAccount.current = next.activeAccountId
      setModels(cachedModels(next.accounts.find((account) => account.id === next.activeAccountId)))
      callback.current?.()
    }
    return next
  }, [])
  const discover = useCallback(async (accountId: string) => {
    setRefreshing(true)
    try {
      const result = await client.discoverModels(accountId)
      const current = await antigravityNative.listAccounts()
      if (current.activeAccountId !== accountId) return
      await antigravityNative.updateAccountCache({ accountId, project: result.project, modelCache: result.models })
      setModels(result.models)
      if (mounted.current) { setError(''); await refresh() }
    } finally { if (mounted.current) setRefreshing(false) }
  }, [refresh])
  useEffect(() => {
    mounted.current = true
    let disposed = false
    const handles: PluginListenerHandle[] = []
    const retain = (handle: PluginListenerHandle) => { if (disposed) void handle.remove(); else handles.push(handle) }
    const update = () => { void refresh().catch((reason) => { if (!disposed) setError(reason instanceof Error ? reason.message : String(t('Failed to load accounts'))) }) }
    update()
    void antigravityNative.addListener('accountsChanged', update).then(retain)
    void App.addListener('appStateChange', ({ isActive }) => { if (isActive) update() }).then(retain)
    return () => { disposed = true; mounted.current = false; for (const handle of handles) void handle.remove() }
  }, [refresh, t])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(t('Operation failed'))) }
    finally { if (mounted.current) { await refresh().catch(() => {}); setBusy(false) } }
  }
  const active = state?.accounts.find((account) => account.id === state.activeAccountId)
  const pending = busy || state?.oauthPending
  return <Stack gap="xs">
    <Text fw={600}>{t('Google account')}</Text>
    {!!state?.accounts.length && <Select label={t('Account')} value={state.activeAccountId || null}
      data={state.accounts.map((account) => ({ value: account.id, label: account.email || account.name || account.id }))}
      disabled={!!pending || refreshing} allowDeselect={false}
      onChange={(accountId) => { if (accountId) void run(async () => { await antigravityNative.switchAccount({ accountId }); await refresh(); await discover(accountId) }) }} />}
    {active?.reauthRequired && <Text size="sm" c="red">{t('Please sign in to this account again.')}</Text>}
    <Group gap="xs">
      <Button variant="light" loading={busy && !state?.oauthPending} disabled={!!pending || refreshing || state?.oauthConfigured === false}
        onClick={() => void run(async () => { const result = await antigravityNative.addAccount(); await refresh(); await discover(result.activeAccountId) })}>
        {t(state?.accounts.length ? 'Add Google account' : 'Sign in with Google')}
      </Button>
      {state?.oauthPending && <Button variant="subtle" onClick={() => void run(async () => { await antigravityNative.cancelOAuth() })}>{t('Cancel')}</Button>}
      {active && <Button variant="subtle" loading={refreshing} disabled={!!pending} onClick={() => void run(() => discover(active.id))}>{t('Refresh models')}</Button>}
      {active && <Button color="red" variant="subtle" disabled={!!pending || refreshing} onClick={() => void run(async () => { await antigravityNative.removeAccount({ accountId: active.id }); await refresh() })}>{t('Logout')}</Button>}
    </Group>
    {error && <Text size="sm" c="red" role="alert">{error}</Text>}
    {state?.oauthConfigured === false && <Text size="sm" c="red">{t('Google sign-in is not configured in this build.')}</Text>}
  </Stack>
}
