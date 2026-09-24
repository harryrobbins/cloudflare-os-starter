// Shared presentation pieces, styled to match the Context Library (Kumo + the Workshop palette).

import { Button, Dialog } from '@cloudflare/kumo'
import { Warning, X } from '@phosphor-icons/react'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { usePresentWhileOpen } from '../bridge'
import { describeError, type DisplayError } from '../errors'

// ---------------------------------------------------------------------------------------------
// Buttons

const TONE = {
  primary: '!bg-kumo-contrast !text-kumo-inverse enabled:hover:!opacity-90',
  secondary: '!bg-kumo-base !text-kumo-default border border-kumo-line enabled:hover:!bg-kumo-tint',
  ghost: '!bg-transparent !text-kumo-subtle enabled:hover:!bg-kumo-tint enabled:hover:!text-kumo-default',
  danger: '!bg-kumo-danger !text-white enabled:hover:!opacity-90',
} as const

export function Btn({
  tone = 'secondary',
  className = '',
  type = 'button',
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'shape'> & { tone?: keyof typeof TONE }) {
  const variant = tone === 'primary' ? 'primary' : tone === 'danger' ? 'destructive' : tone === 'ghost' ? 'ghost' : 'secondary'
  return (
    <Button
      {...props}
      type={type}
      variant={variant}
      size="sm"
      className={`!h-8 rounded-lg !px-3 text-[13px] font-medium shadow-none transition-[background-color,opacity,transform] duration-150 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-ring ${TONE[tone]} ${className}`}
    />
  )
}

// ---------------------------------------------------------------------------------------------
// Form fields (native controls with explicit labels: accessible and predictable)

const CONTROL =
  'h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] text-kumo-default placeholder:text-kumo-inactive focus:border-kumo-ring focus:outline-none focus:ring-2 focus:ring-kumo-ring/30 disabled:opacity-60'

export function TextField({
  label,
  hint,
  optional,
  className = '',
  ...input
}: ComponentProps<'input'> & { label: string; hint?: ReactNode; optional?: boolean }) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 flex gap-1.5 text-[12px] font-medium text-kumo-subtle">
        {label}
        {optional ? <span className="font-normal text-kumo-inactive">Optional</span> : null}
      </label>
      <input id={id} aria-describedby={hint ? hintId : undefined} className={CONTROL} {...input} />
      {hint ? (
        <p id={hintId} className="mt-1 text-[12px] text-kumo-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function TextAreaField({
  label,
  optional,
  className = '',
  ...input
}: ComponentProps<'textarea'> & { label: string; optional?: boolean }) {
  const id = useId()
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 flex gap-1.5 text-[12px] font-medium text-kumo-subtle">
        {label}
        {optional ? <span className="font-normal text-kumo-inactive">Optional</span> : null}
      </label>
      <textarea id={id} className={`${CONTROL} h-auto py-2`} rows={3} {...input} />
    </div>
  )
}

export function SelectField({
  label,
  options,
  className = '',
  hideLabel,
  ...select
}: ComponentProps<'select'> & {
  label: string
  hideLabel?: boolean
  options: { value: string; label: string }[]
}) {
  const id = useId()
  return (
    <div className={className}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'mb-1.5 block text-[12px] font-medium text-kumo-subtle'}>
        {label}
      </label>
      <select id={id} className={CONTROL} {...select}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function CheckboxField({
  label,
  description,
  ...input
}: Omit<ComponentProps<'input'>, 'type'> & { label: string; description?: ReactNode }) {
  const id = useId()
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-kumo-brand)]" {...input} />
      <label htmlFor={id} className="text-[13px] text-kumo-default">
        {label}
        {description ? <span className="block text-[12px] text-kumo-subtle">{description}</span> : null}
      </label>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Feedback

export function ErrorNotice({ error, className = '' }: { error: DisplayError | null; className?: string }) {
  if (!error) return null
  return (
    <div
      role="alert"
      data-error-code={error.code ?? 'unknown'}
      className={`flex gap-2 rounded-lg border border-kumo-danger/40 bg-kumo-danger-tint px-3 py-2 text-[13px] text-kumo-default ${className}`}
    >
      <Warning size={16} weight="bold" className="mt-0.5 shrink-0 text-kumo-danger" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{error.title}</p>
        {error.detail ? <p className="text-kumo-subtle">{error.detail}</p> : null}
        {error.issues.length ? (
          <ul className="mt-1 list-disc pl-4 text-kumo-subtle">
            {error.issues.map((i, n) => (
              <li key={n}>
                <code>{i.path}</code>: {i.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'success' | 'warning' }) {
  const bg = tone === 'success' ? 'bg-kumo-success-tint' : tone === 'warning' ? 'bg-kumo-warning-tint' : 'bg-kumo-info-tint'
  return (
    <div role="status" className={`rounded-lg px-3 py-2 text-[13px] text-kumo-default ${bg}`}>
      {children}
    </div>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' | 'warning' | 'danger' | 'success' }) {
  const cls = {
    neutral: 'bg-kumo-fill text-kumo-default',
    brand: 'bg-kumo-brand/15 text-kumo-brand',
    warning: 'bg-kumo-warning-tint text-kumo-warning',
    danger: 'bg-kumo-danger-tint text-kumo-danger',
    success: 'bg-kumo-success-tint text-kumo-success',
  }[tone]
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="py-6 text-center text-[13px] text-kumo-subtle">
      {label}
    </p>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-kumo-subtle">{children}</p>
}

export function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-[15px] font-medium text-kumo-default">{title}</h3>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Tables

export function Table({ label, head, children }: { label: string; head: string[]; children: ReactNode }) {
  return (
    <div className="ctx-scroll overflow-x-auto rounded-lg border border-kumo-line">
      <table aria-label={label} className="w-full border-collapse text-left text-[13px]">
        <thead className="bg-kumo-elevated text-[12px] text-kumo-subtle">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-kumo-line">{children}</tbody>
      </table>
    </div>
  )
}

export const TD = 'px-3 py-2 align-top'

// ---------------------------------------------------------------------------------------------
// Tabs (WAI-ARIA tabs pattern: arrow keys move, Home/End jump)

export function Tabs<K extends string>({
  label,
  tabs,
  active,
  onChange,
  idPrefix,
}: {
  label: string
  tabs: { key: K; label: string }[]
  active: K
  onChange: (key: K) => void
  idPrefix: string
}) {
  const refs = useRef(new Map<K, HTMLButtonElement>())
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.key === active)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    const key = tabs[next]!.key
    onChange(key)
    refs.current.get(key)?.focus()
  }
  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex gap-1 overflow-x-auto border-b border-kumo-line">
      {tabs.map((t) => {
        const selected = t.key === active
        return (
          <button
            key={t.key}
            ref={(el) => {
              if (el) refs.current.set(t.key, el)
              else refs.current.delete(t.key)
            }}
            role="tab"
            type="button"
            id={`${idPrefix}-tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-kumo-ring ${
              selected ? 'border-kumo-brand text-kumo-default' : 'border-transparent text-kumo-subtle hover:text-kumo-default'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Modal (Kumo Dialog under the Workshop's full-viewport presentation; see bridge.ts)

export function Modal({
  open,
  onClose,
  title,
  description,
  busy = false,
  children,
  width = 520,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: ReactNode
  busy?: boolean
  children: ReactNode
  width?: number
}) {
  const { presenting, onOpenChangeComplete } = usePresentWhileOpen(open)
  return (
    <Dialog.Root
      open={open && presenting}
      onOpenChange={(next: boolean) => {
        if (!next && !busy) onClose()
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog
        className="z-[1000]! max-h-[84vh] overflow-y-auto bg-kumo-base p-0 top-[8%]! translate-y-0!"
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        size="lg"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[17px] leading-6 font-medium text-kumo-default">{title}</Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-1 text-[13px] text-kumo-subtle">{description}</Dialog.Description>
            ) : null}
          </div>
          <Dialog.Close
            disabled={busy}
            render={(props) => (
              <button
                {...props}
                type="button"
                aria-label="Close"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
              >
                <X size={18} />
              </button>
            )}
          />
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
      </Dialog>
    </Dialog.Root>
  )
}

export function ModalFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 border-t border-kumo-line pt-4">{children}</div>
}

/** A confirm dialog for destructive or significant actions. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'primary'
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const action = useAction()
  return (
    <Modal open={open} onClose={onClose} title={title} busy={action.busy}>
      <div className="text-[13px] text-kumo-default">{body}</div>
      <ErrorNotice error={action.error} />
      <ModalFooter>
        <Btn onClick={onClose} disabled={action.busy}>
          Cancel
        </Btn>
        <Btn
          tone={tone}
          loading={action.busy}
          onClick={() =>
            void action.run(async () => {
              await onConfirm()
              onClose()
            })
          }
        >
          {confirmLabel}
        </Btn>
      </ModalFooter>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Hooks

/** Run one async action at a time, capturing its error for display. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<DisplayError | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      if (mounted.current) setError(describeError(err))
      return undefined
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])
  return { busy, error, setError, run }
}

/** Debounce a changing value. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * A form without the native form element. The Workshop hosts this page in a sandboxed iframe without
 * `allow-forms`, where the browser blocks native form submission before `submit` fires, so
 * `onSubmit` never runs. This wrapper submits on Enter in a single-line field, and each submit button
 * calls the same handler from `onClick`.
 */
export function SandboxForm({
  onSubmit,
  className,
  label,
  children,
}: {
  onSubmit: () => void
  className?: string
  label?: string
  children: ReactNode
}) {
  return (
    <div
      role="form"
      aria-label={label}
      className={className}
      onKeyDown={(e) => {
        const t = e.target
        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
        if (t instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(t.type)) {
          e.preventDefault()
          onSubmit()
        }
      }}
    >
      {children}
    </div>
  )
}
