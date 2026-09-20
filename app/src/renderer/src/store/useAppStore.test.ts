import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '@renderer/store/useAppStore'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      projectName: 'Sylor',
      isMaximized: false,
      settings: DEFAULT_PROVIDER_SETTINGS,
      settingsLoaded: false,
      models: [],
      modelsLoading: false,
      settingsOpen: false,
      settingsTab: null,
      envStatus: 'local',
      model: DEFAULT_PROVIDER_SETTINGS.modelName,
      theme: DEFAULT_PROVIDER_SETTINGS.ui.theme,
      railOpen: true
    })
  })

  it('exposes the expected defaults', () => {
    const state = useAppStore.getState()
    expect(state.projectName).toBe('Sylor')
    expect(state.envStatus).toBe('local')
    expect(state.isMaximized).toBe(false)
    expect(state.settings.activeProvider).toBe('ollama')
    // No model is pre-selected on first launch — the user picks one.
    expect(state.model).toBe('')
  })

  it('tracks the maximized flag', () => {
    useAppStore.getState().setMaximized(true)
    expect(useAppStore.getState().isMaximized).toBe(true)
  })

  it('toggles the conversation rail', () => {
    expect(useAppStore.getState().railOpen).toBe(true)
    useAppStore.getState().toggleRail()
    expect(useAppStore.getState().railOpen).toBe(false)
    useAppStore.getState().setRailOpen(true)
    expect(useAppStore.getState().railOpen).toBe(true)
  })

  it('opens Settings directly to a specific tab', () => {
    useAppStore.getState().openSettings('model')
    expect(useAppStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: 'model' })
  })

  it('derives envStatus and model from the active provider', async () => {
    const { settings } = useAppStore.getState()
    await useAppStore.getState().saveSettings({
      ...settings,
      activeProvider: 'gateway',
      modelId: 'gpt-4o-mini',
      modelName: 'GPT-4o mini'
    })
    const state = useAppStore.getState()
    expect(state.envStatus).toBe('remote')
    expect(state.model).toBe('GPT-4o mini')
  })
})
