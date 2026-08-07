import React, { useEffect, useState } from 'react'
import AirforShare from './component/Airforshare.jsx'
import InstallPrompt from './component/InstallPrompt.jsx'
import { checkVpnReachable } from './api.js'

const App = () => {
  const [vpnOk, setVpnOk] = useState(null) // null = checking

  useEffect(() => {
    let alive = true
    checkVpnReachable().then((onVpn) => {
      if (!alive) return
      setVpnOk(onVpn)
    })
    return () => {
      alive = false
    }
  }, [])

  if (vpnOk === false) {
    return (
      <div
        style={{
          margin: 0,
          minHeight: '100vh',
          width: '100%',
          background: '#fff',
          color: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          fontSize: '1.5rem',
        }}
      >
        helloworld
      </div>
    )
  }

  if (vpnOk === null) {
    return <div className='login-page'><p className='login-sub'>Loading…</p></div>
  }

  return (
    <>
      <InstallPrompt />
      <AirforShare />
    </>
  )
}

export default App
