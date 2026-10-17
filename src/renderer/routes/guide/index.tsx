import { Navigate, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/guide/')({
  component: GuidePage,
})

function GuidePage() {
  return <Navigate to="/settings/provider" replace />
}
