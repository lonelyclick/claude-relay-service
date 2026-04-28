import { NavLink } from 'react-router'
import { cn } from '~/lib/cn'

export function TabNav({ items }: { items: { to: string; label: string; end?: boolean }[] }) {
  return (
    <div className="flex border-b border-ccdash-border mb-6">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
              isActive
                ? 'text-blue-400 border-blue-400'
                : 'text-slate-400 border-transparent hover:text-slate-200',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  )
}
