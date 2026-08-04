import React, { useEffect, useState } from 'react'
import AirforShare from './component/Airforshare.jsx'
import Login from './component/Login.jsx'
import InstallPrompt from './component/InstallPrompt.jsx'
import { checkAuth, logoutRequest, disconnectShareSocket } from './api.js'

const App = () => {
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let alive = true
    checkAuth().then((ok) => {
      if (!alive) return
      setAuthed(ok)
      setChecking(false)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onLogout = () => {
      disconnectShareSocket()
      setAuthed(false)
    }
    window.addEventListener('auth:logout', onLogout)
    return () => window.removeEventListener('auth:logout', onLogout)
  }, [])

  const handleLogout = async () => {
    disconnectShareSocket()
    await logoutRequest()
    setAuthed(false)
  }

  if (checking) {
    return <div className='login-page'><p className='login-sub'>Loading…</p></div>
  }

  return (
    <>
      <InstallPrompt />
      {!authed ? (
        <Login onSuccess={() => setAuthed(true)} />
      ) : (
        <AirforShare onLogout={handleLogout} />
      )}
    </>
  )
}

export default App
