import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { cn } from '~/lib/cn'

interface Toast {
  id: string
  message: string
  type: 'success' | 'error'
}

interface ToastContextValue {
  success: (message: string) => void
  error: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const add = useCallback((message: string, type: Toast['type']) => {
    const id = crypto.randomUUID()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500)
  }, [])

  const success = useCallback((msg: string) => add(msg, 'success'), [add])
  const error = useCallback((msg: string) => add(msg, 'error'), [add])

  return (
    <ToastContext.Provider value={{ success, error }}>
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'px-4 py-2.5 rounded-lg text-[13px] font-medium shadow-dropdown backdrop-blur-md pointer-events-auto',
              'animate-[slideIn_0.25s_ease]',
              t.type === 'success' && 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30',
              t.type === 'error' && 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
