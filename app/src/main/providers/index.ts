import type {
  GatewayConfig,
  OllamaConfig,
  ProviderKind,
  ProviderSettings
} from '../../shared/types'
import { GatewayProvider } from './gateway'
import { OllamaProvider } from './ollama'
import type { Provider } from './provider'

export type { Provider } from './provider'
export { collectCompletion } from './collect'

/** Build a provider from an explicit kind + (possibly unsaved) config. */
export function createProvider(
  kind: ProviderKind,
  config: OllamaConfig | GatewayConfig
): Provider {
  return kind === 'ollama'
    ? new OllamaProvider(config as OllamaConfig)
    : new GatewayProvider(config as GatewayConfig)
}

/** Build the currently active provider from saved settings. */
export function providerFromSettings(settings: ProviderSettings): Provider {
  return settings.activeProvider === 'ollama'
    ? new OllamaProvider(settings.ollama)
    : new GatewayProvider(settings.gateway)
}
