import { NavLink } from 'react-router'
import { cn } from '~/lib/cn'

export function TabNav({ items }: { items: { to: string; label: string; end?: boolean }[] }) {
  return (
    <div className="flex border-b border-border-default mb-5">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors duration-150',
              isActive
                ? 'text-indigo-400 border-indigo-400'
                : 'text-slate-500 border-transparent hover:text-slate-300 hover:border-slate-600',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  )
}
