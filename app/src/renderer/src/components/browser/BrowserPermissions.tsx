/**
 * The browsing-permission panel — in plain language, exactly what Sylor is allowed
 * to do on a web page on the user's behalf, and a control to change each policy.
 * Every risk class can be set to Allow / Ask / Block, with two hard rules:
 *   - Payment can never be set to Allow (it stays Ask or Block) — money never
 *     moves without an explicit yes. `decideBrowse` blocks it outright regardless.
 *   - Reading and navigating are the only classes open by default; everything that
 *     changes something starts gated.
 *
 * The policy lives in main-process settings (`ProviderSettings.browser`), which is
 * what the engine's `browse` gate actually reads — so what the user sets here is
 * what governs the agent, in Cowork and Code alike. Two rules in `decideBrowse` are
 * deliberately NOT configurable and this panel says so: send/post and delete always
 * ask even when set to Allow.
 */
import type { BrowserAction, BrowserPermission } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

/** Display metadata for each gated action, ordered by escalating blast radius. */
const ACTIONS: { action: BrowserAction; label: string; hint: string; sensitive?: boolean }[] = [
  { action: 'read', label: 'Read page', hint: 'See page text and structure.' },
  { action: 'navigate', label: 'Navigate', hint: 'Follow links and open URLs.' },
  { action: 'click', label: 'Click', hint: 'Click buttons and controls.' },
  { action: 'fill', label: 'Fill forms', hint: 'Type into fields (never passwords).' },
  {
    action: 'send',
    label: 'Send / post',
    hint: 'Submit, post, or message. Always asks, even on Allow.',
    sensitive: true
  },
  {
    action: 'delete',
    label: 'Delete data',
    hint: 'Remove or destroy data. Always asks, even on Allow.',
    sensitive: true
  },
  {
    action: 'payment',
    label: 'Payment',
    hint: 'Sylor never pays, orders, or subscribes for you.',
    sensitive: true
  }
]

const LEVELS: { value: BrowserPermission; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'block', label: 'Block' }
]

function PermissionRow({
  action,
  label,
  hint,
  sensitive,
  value,
  onChange
}: {
  action: BrowserAction
  label: string
  hint: string
  sensitive?: boolean
  value: BrowserPermission
  onChange: (v: BrowserPermission) => void
}) {
  // Payment may never be "Allow": money never moves silently.
  const paymentLocked = action === 'payment'
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-text">
            {label}
            {sensitive && (
              <span className="rounded-sm bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-400">
                sensitive
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">{hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2/70 p-0.5">
          {LEVELS.map((lvl) => {
            const disabled = paymentLocked && lvl.value === 'allow'
            const active = value === lvl.value
            return (
              <button
                key={lvl.value}
                type="button"
                disabled={disabled}
                title={disabled ? 'Payments can never be auto-approved' : undefined}
                onClick={() => onChange(lvl.value)}
                className={
                  'rounded-md px-2 py-1 text-[11px] font-medium transition-colors ' +
                  (disabled
                    ? 'cursor-not-allowed text-muted/30'
                    : active
                      ? lvl.value === 'block'
                        ? 'bg-red-500/15 text-red-400'
                        : lvl.value === 'allow'
                          ? 'bg-primary text-bg'
                          : 'bg-amber-500/20 text-amber-400'
                      : 'text-muted hover:text-text')
                }
              >
                {lvl.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * The Browsing pane of Settings. An embedded section (not a drawer): the policy is
 * ordinary persisted configuration now, so it belongs beside the other settings
 * rather than behind a browser-panel button.
 */
export function BrowserPermissionsSection() {
  const permissions = useAppStore((s) => s.browserPermissions())
  const setPermission = useAppStore((s) => s.setBrowserPermission)

  return (
    <div className="space-y-4">
      <p className="text-[12px] leading-relaxed text-muted">
        What Sylor may do on a web page without asking you first — it applies wherever the
        agent browses, in Cowork and in Code. Your passwords, cookies, and session tokens
        are never shared with the model, whatever you choose here. Sending, posting and
        deleting always ask, and payment is always refused, even if you set them to Allow.
      </p>
      <div className="divide-y divide-border rounded-lg border border-border bg-bg px-3">
        {ACTIONS.map((a) => (
          <PermissionRow
            key={a.action}
            action={a.action}
            label={a.label}
            hint={a.hint}
            sensitive={a.sensitive}
            value={permissions[a.action]}
            onChange={(v) => void setPermission(a.action, v)}
          />
        ))}
      </div>
    </div>
  )
}
