import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/settings/chatbox-ai')({
  component: RouteComponent,
})

export function RouteComponent() {
  return <Navigate to="/settings/provider" replace />
}
