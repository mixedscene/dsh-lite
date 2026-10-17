import NiceModal, { useModal } from '@ebay/nice-modal-react'
import { useEffect } from 'react'

const AppStoreRating = NiceModal.create(() => {
  const modal = useModal()
  const { visible, resolve, hide, remove } = modal

  useEffect(() => {
    if (visible) {
      resolve()
      void hide()
      remove()
    }
  }, [visible, resolve, hide, remove])

  return null
})

export default AppStoreRating
