import { Outlet } from 'react-router'
import { Topbar } from './Topbar'
import { Sidebar } from './Sidebar'
import { ToastProvider } from './Toast'

export function Layout() {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-ccdash-bg">
        <Topbar />
        <div className="flex max-md:flex-col max-w-[1200px] mx-auto w-full" style={{ height: 'calc(100vh - 2.75rem)' }}>
          <Sidebar />
          <main className="flex-1 overflow-y-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </ToastProvider>
  )
}
