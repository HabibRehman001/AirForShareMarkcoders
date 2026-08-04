import React, { useEffect, useState } from 'react'

const InstallPrompt = () => {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [visible, setVisible] = useState(false)
  const [iosHint, setIosHint] = useState(false)

  useEffect(() => {
    const dismissed = sessionStorage.getItem('pwa_install_dismissed') === '1'
    if (dismissed) return

    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true

    if (isStandalone) return

    const ua = window.navigator.userAgent || ''
    const isIOS = /iPhone|iPad|iPod/i.test(ua)
    const isMobile = /Android|iPhone|iPad|iPod/i.test(ua)

    if (isIOS && isMobile) {
      setIosHint(true)
      setVisible(true)
      return
    }

    const onBeforeInstall = (e) => {
      e.preventDefault()
      setDeferredPrompt(e)
      setVisible(true)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  }, [])

  const dismiss = () => {
    sessionStorage.setItem('pwa_install_dismissed', '1')
    setVisible(false)
  }

  const install = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    await deferredPrompt.userChoice
    setDeferredPrompt(null)
    dismiss()
  }

  if (!visible) return null

  return (
    <div className='pwa-banner' role='dialog' aria-live='polite'>
      <div className='pwa-banner__content'>
        <img src='/logo.jpg' alt='' className='pwa-banner__logo' />
        <div>
          <p className='pwa-banner__title'>Install MarkCoders.Share</p>
          <p className='pwa-banner__text'>
            {iosHint
              ? 'On iPhone: tap Share, then Add to Home Screen'
              : 'Use this site like an app on your phone'}
          </p>
        </div>
      </div>
      <div className='pwa-banner__actions'>
        {!iosHint && deferredPrompt && (
          <button type='button' className='btn btn-primary pwa-banner__install' onClick={install}>
            Install app
          </button>
        )}
        <button type='button' className='btn btn-ghost pwa-banner__close' onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  )
}

export default InstallPrompt
