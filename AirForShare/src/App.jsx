import React, { useEffect, useState } from 'react'
import AirforShare from './component/Airforshare.jsx'
import Login from './component/Login.jsx'
import InstallPrompt from './component/InstallPrompt.jsx'
import { clearToken, isLoggedIn } from './api.js'

const App = () => {
  const [authed, setAuthed] = useState(() => isLoggedIn())

  useEffect(() => {
    const onLogout = () => setAuthed(false)
    window.addEventListener('auth:logout', onLogout)
    return () => window.removeEventListener('auth:logout', onLogout)
  }, [])

  const handleLogout = () => {
    clearToken()
    setAuthed(false)
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
