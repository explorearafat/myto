/**
 * Sylorium AI-permission panel (requirements 13 & 14). A slide-in drawer that
 * shows — in plain language — exactly what Sylor is allowed to do on the user's
 * behalf, and lets the user change each policy. Every action class can be set to
 * Allow / Ask / Block, with two hard rules the UI enforces:
 *   - Payment can never be set to Allow (it stays Ask or Block) — money never
 *     moves without an explicit yes.
 *   - Reading is the only class that's open by default; everything that mutates
 *     state starts gated.
 *
 * Policies persist through the store (localStorage), so the user's posture holds
 * across launches.
 */
import type { SyloriumAction, SyloriumPermission } from '@shared/types'
import { useAppStore } from '@renderer/store/useAppStore'

/** Display metadata for each gated action, ordered by escalating blast radius. */
const ACTIONS: { action: SyloriumAction; label: string; hint: string; sensitive?: boolean }[] = [
  { action: 'read', label: 'Read page', hint: 'See page text and structure.' },
  { action: 'navigate', label: 'Navigate', hint: 'Follow links, open URLs, switch tabs.' },
  { action: 'click', label: 'Click', hint: 'Click buttons and controls.' },
  { action: 'fill', label: 'Fill forms', hint: 'Type into fields (never passwords).' },
  { action: 'send', label: 'Send / post', hint: 'Submit forms, post, or message.', sensitive: true },
  { action: 'delete', label: 'Delete data', hint: 'Remove or destroy data.', sensitive: true },
  {
    action: 'payment',
    label: 'Payment',
    hint: 'Purchases always require your approval.',
    sensitive: true
  }
]

const LEVELS: { value: SyloriumPermission; label: string }[] = [
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
  action: SyloriumAction
  label: string
  hint: string
  sensitive?: boolean
  value: SyloriumPermission
  onChange: (v: SyloriumPermission) => void
}) {
  // Payment may never be "Allow": money never moves silently (requirement 13).
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

export function SyloriumPermissions({ onClose }: { onClose: () => void }) {
  const permissions = useAppStore((s) => s.syloriumPermissions)
  const setPermission = useAppStore((s) => s.setSyloriumPermission)

  return (
    <div className="flex h-full w-full max-w-sm flex-col bg-surface shadow-2xl sylor-drawer-in">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-primary">
            <path
              d="M8 1.5l5 2v3.2c0 3-2.1 5.6-5 6.8-2.9-1.2-5-3.8-5-6.8V3.5l5-2Z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          <h2 className="text-[13px] font-medium text-text">AI permissions</h2>
        </div>
        <button
          type="button"
          aria-label="Close permissions"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <p className="py-3 text-[11px] leading-relaxed text-muted">
          What Sylor may do on this browser without asking you first. Passwords, cookies, and
          session tokens are never shared with the AI, whatever you choose here.
        </p>
        <div className="divide-y divide-border">
          {ACTIONS.map((a) => (
            <PermissionRow
              key={a.action}
              action={a.action}
              label={a.label}
              hint={a.hint}
              sensitive={a.sensitive}
              value={permissions[a.action]}
              onChange={(v) => setPermission(a.action, v)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
