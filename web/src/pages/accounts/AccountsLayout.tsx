import { Outlet } from 'react-router'
import { TabNav } from '~/components/TabNav'

const tabs = [
  { to: '/accounts', label: 'Inventory', end: true },
  { to: '/accounts/recovery', label: 'Recovery' },
  { to: '/accounts/new', label: 'Onboard' },
]

export function AccountsLayout() {
  return (
    <>
      <TabNav items={tabs} />
      <Outlet />
    </>
  )
}
