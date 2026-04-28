import { NavLink } from 'react-router'
import { cn } from '~/lib/cn'

const navItems = [
  { to: '/dashboard', label: 'Overview' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/routing', label: 'Routing' },
  { to: '/usage', label: 'Usage' },
  { to: '/billing', label: 'Billing' },
  { to: '/network', label: 'Network' },
  { to: '/users', label: 'Users' },
]

export function Sidebar() {
  return (
    <nav className="w-52 shrink-0 border-r border-ccdash-border bg-ccdash-bg pt-3 max-md:w-full max-md:border-r-0 max-md:border-b max-md:flex max-md:gap-1 max-md:px-3 max-md:pt-0 max-md:pb-2 max-md:overflow-x-auto">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            cn(
              'block px-5 py-2 text-sm rounded-lg mx-2 transition-colors',
              'max-md:mx-0 max-md:px-3 max-md:py-1.5 max-md:whitespace-nowrap',
              isActive
                ? 'text-slate-100 bg-ccdash-card-strong font-medium'
                : 'text-slate-400 hover:text-slate-200 hover:bg-ccdash-card/60',
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
