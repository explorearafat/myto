import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '@renderer/store/useAppStore'
import { DEFAULT_PROVIDER_SETTINGS } from '@shared/defaults'

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.setState({
      projectName: 'Sylor',
      permissionMode: 'ask',
      isMaximized: false,
      settings: DEFAULT_PROVIDER_SETTINGS,
      settingsLoaded: false,
      models: [],
      modelsLoading: false,
      settingsOpen: false,
      envStatus: 'local',
      model: DEFAULT_PROVIDER_SETTINGS.modelName,
      theme: DEFAULT_PROVIDER_SETTINGS.ui.theme
    })
  })

  it('exposes the expected defaults', () => {
    const state = useAppStore.getState()
    expect(state.projectName).toBe('Sylor')
    expect(state.permissionMode).toBe('ask')
    expect(state.envStatus).toBe('local')
    expect(state.isMaximized).toBe(false)
    expect(state.settings.activeProvider).toBe('ollama')
    // No model is pre-selected on first launch — the user picks one.
    expect(state.model).toBe('')
  })

  it('updates the permission mode', () => {
    useAppStore.getState().setPermissionMode('auto-edit')
    expect(useAppStore.getState().permissionMode).toBe('auto-edit')
  })

  it('tracks the maximized flag', () => {
    useAppStore.getState().setMaximized(true)
    expect(useAppStore.getState().isMaximized).toBe(true)
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

/**
 * The right slot holds one of three surfaces — the live preview, the browser, the
 * canvas — because all three draw over the same rectangle. The browser is the one
 * that matters most here: its page is a NATIVE view the main process floats above
 * the DOM, so merely clearing `browserOpen` would leave the page hovering over the
 * canvas. Taking the slot from it has to hide the view too.
 */
describe('useAppStore right-slot exclusivity', () => {
  beforeEach(() => {
    useAppStore.setState({
      previewOpen: false,
      browserOpen: false,
      canvasOpen: false,
      canvasMode: 'log'
    })
  })

  it('opening the canvas closes whichever surface held the slot', () => {
    useAppStore.setState({ previewOpen: true })
    useAppStore.getState().openCanvas()
    expect(useAppStore.getState()).toMatchObject({ canvasOpen: true, previewOpen: false })

    useAppStore.getState().openBrowser()
    expect(useAppStore.getState()).toMatchObject({ browserOpen: true, canvasOpen: false })

    useAppStore.getState().openPreview()
    expect(useAppStore.getState()).toMatchObject({ previewOpen: true, canvasOpen: false })
  })

  it('switching surface while open does not close the canvas', () => {
    useAppStore.getState().toggleCanvas('log')
    expect(useAppStore.getState().canvasOpen).toBe(true)

    // Same surface again means "hide this"; the mode is remembered for next time.
    useAppStore.getState().toggleCanvas('log')
    expect(useAppStore.getState()).toMatchObject({ canvasOpen: false, canvasMode: 'log' })
  })

  it('selecting a mode on a closed canvas opens it there', () => {
    useAppStore.getState().setCanvasMode('diff')
    expect(useAppStore.getState()).toMatchObject({ canvasOpen: true, canvasMode: 'diff' })
  })
})
