import dayjs from 'dayjs'
import { useEffect, useState } from 'react'
import platform from '../platform'

function getInitialTime() {
  let initialTime = Number.parseInt(localStorage.getItem('initial-time') || '')
  if (!initialTime) {
    initialTime = Date.now()
    localStorage.setItem('initial-time', `${initialTime}`)
  }
  return initialTime
}

export function isFirstDay(): boolean {
  return dayjs().isSame(dayjs(getInitialTime()), 'day')
}

export default function useVersion() {
  const [version, setVersion] = useState('')
  useEffect(() => {
    let active = true
    void platform.getVersion().then((value) => {
      if (active) setVersion(value)
    }).catch((error: unknown) => console.error('Failed to read app version:', error))
    return () => { active = false }
  }, [])

  return {
    version,
    versionLoaded: !!version,
    isExceeded: false,
    isExceededResolved: true,
    needCheckUpdate: false,
  }
}
