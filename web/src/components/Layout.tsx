import { Outlet } from 'react-router'
import { Topbar } from './Topbar'
import { Sidebar } from './Sidebar'
import { ToastProvider } from './Toast'

export function Layout() {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-bg-primary">
        <Topbar />
        <div className="flex max-md:flex-col max-w-[1280px] mx-auto w-full min-w-0" style={{ height: 'calc(100vh - 2.75rem)' }}>
          <Sidebar />
          <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
