import { NavLink } from 'react-router'
import { cn } from '~/lib/cn'

const sections = [
  {
    items: [
      { to: '/dashboard', label: 'Dashboard' },
    ],
  },
  {
    label: 'Core',
    items: [
      { to: '/accounts', label: 'Accounts' },
      { to: '/routing', label: 'Routing' },
      { to: '/usage', label: 'Usage' },
      { to: '/risk', label: 'Risk Lab' },
    ],
  },
  {
    label: 'Business',
    items: [
      { to: '/billing', label: 'Billing' },
      { to: '/models', label: 'Models' },
    ],
  },
  {
    label: 'Infra',
    items: [
      { to: '/network', label: 'Network' },
      { to: '/users', label: 'Access' },
    ],
  },
  {
    label: 'Support',
    items: [
      { to: '/support', label: 'Tickets' },
    ],
  },
]

export function Sidebar() {
  return (
    <nav className="w-52 shrink-0 border-r border-border-default bg-bg-primary flex flex-col py-4 gap-5 max-md:w-full max-md:border-r-0 max-md:border-b max-md:flex-row max-md:gap-1 max-md:px-3 max-md:py-0 max-md:pb-2 max-md:overflow-x-auto">
      {sections.map((sec) => (
        <div key={sec.label ?? 'top'} className="px-3 max-md:px-0 max-md:flex max-md:gap-1 max-md:items-center">
          {sec.label && (
            <div className="section-header mb-1.5 px-2 max-md:hidden">
              {sec.label}
            </div>
          )}
          <div className="flex flex-col gap-0.5 max-md:flex-row max-md:gap-1">
            {sec.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'block px-3 py-1.5 text-[13px] rounded-lg transition-all duration-150',
                    'max-md:px-2.5 max-md:py-1.5 max-md:whitespace-nowrap max-md:text-xs',
                    isActive
                      ? 'text-slate-100 bg-bg-card-raised font-medium shadow-sm ring-1 ring-border-default'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-bg-card',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}
