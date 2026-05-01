import { createBrowserRouter, Navigate, RouterProvider } from 'react-router'
import { AuthProvider } from '~/auth/AuthProvider'
import { RequireAuth } from '~/auth/RequireAuth'
import { LoginPage } from '~/auth/LoginPage'
import { CallbackPage } from '~/auth/CallbackPage'
import { Layout } from '~/components/Layout'
import { DashboardPage } from '~/pages/dashboard/DashboardPage'
import { AccountsLayout } from '~/pages/accounts/AccountsLayout'
import { InventoryPage } from '~/pages/accounts/InventoryPage'
import { RecoveryPage } from '~/pages/accounts/RecoveryPage'
import { OnboardPage } from '~/pages/accounts/OnboardPage'
import { AccountDetailPage } from '~/pages/accounts/AccountDetailPage'
import { RoutingLayout } from '~/pages/routing/RoutingLayout'
import { GroupsPage } from '~/pages/routing/GroupsPage'
import { GroupDetailPage } from '~/pages/routing/GroupDetailPage'
import { LiveRoutesPage } from '~/pages/routing/LiveRoutesPage'
import { GuardPage } from '~/pages/routing/GuardPage'
import { HandoffsPage } from '~/pages/routing/HandoffsPage'
import { UsagePage } from '~/pages/usage/UsagePage'
import { UsageDetailPage } from '~/pages/usage/UsageDetailPage'
import { BillingPage } from '~/pages/billing/BillingPage'
import { BillingUserPage } from '~/pages/billing/BillingUserPage'
import { ModelsPage } from '~/pages/models/ModelsPage'
import { UsersPage } from '~/pages/users/UsersPage'
import { UserDetailPage } from '~/pages/users/UserDetailPage'
import { OrganizationDetailPage } from '~/pages/users/OrganizationDetailPage'
import { RequestDetailPage } from '~/pages/users/RequestDetailPage'
import { NetworkPage } from '~/pages/network/NetworkPage'
import { ProxyDetailPage } from '~/pages/network/ProxyDetailPage'
import { SupportListPage } from '~/pages/support/SupportListPage'
import { SupportDetailPage } from '~/pages/support/SupportDetailPage'

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/auth/callback', element: <CallbackPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { index: true, element: <Navigate to="/dashboard" replace /> },
          { path: 'dashboard', element: <DashboardPage /> },
          {
            path: 'accounts',
            element: <AccountsLayout />,
            children: [
              { index: true, element: <InventoryPage /> },
              { path: 'recovery', element: <RecoveryPage /> },
              { path: 'new', element: <OnboardPage /> },
            ],
          },
          { path: 'accounts/:id', element: <AccountDetailPage /> },
          {
            path: 'routing',
            element: <RoutingLayout />,
            children: [
              { index: true, element: <GroupsPage /> },
              { path: 'live', element: <LiveRoutesPage /> },
              { path: 'guard', element: <GuardPage /> },
              { path: 'handoffs', element: <HandoffsPage /> },
              { path: 'groups/:id', element: <GroupDetailPage /> },
            ],
          },
          { path: 'usage', element: <UsagePage /> },
          { path: 'usage/:accountId', element: <UsageDetailPage /> },
          { path: 'billing', element: <BillingPage /> },
          { path: 'billing/users/:id', element: <BillingUserPage /> },
          { path: 'models', element: <ModelsPage /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'users/organizations/:organizationId', element: <OrganizationDetailPage /> },
          { path: 'users/:id', element: <UserDetailPage /> },
          { path: 'users/:id/requests/:requestId', element: <RequestDetailPage /> },
          { path: 'network', element: <NetworkPage /> },
          { path: 'network/:id', element: <ProxyDetailPage /> },
          { path: 'support', element: <SupportListPage /> },
          { path: 'support/:id', element: <SupportDetailPage /> },
        ],
      },
    ],
  },
])

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  )
}
