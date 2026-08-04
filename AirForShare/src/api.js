import axios from 'axios'
import { io } from 'socket.io-client'

const PROD_API = 'https://airforsharemarkcoders.onrender.com'

export const API_BASE = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? PROD_API : '')
).replace(/\/$/, '')

export function apiUrl(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${API_BASE}${normalized}`
}

export async function authFetch(path, options = {}) {
  const headers = new Headers(options.headers || {})
  const res = await fetch(apiUrl(path), {
    ...options,
    headers,
    credentials: 'include',
  })

  if (res.status === 401 && path !== '/api/me' && path !== '/api/login') {
    window.dispatchEvent(new Event('auth:logout'))
  }

  return res
}

/**
 * Upload FormData with live 0–100 progress via axios onUploadProgress.
 * Pass AbortSignal to allow cancel mid-upload.
 */
export async function uploadWithProgress(path, formData, onProgress, signal) {
  try {
    if (typeof onProgress === 'function') onProgress(0)

    const response = await axios.post(apiUrl(path), formData, {
      withCredentials: true,
      signal,
      onUploadProgress: (event) => {
        if (typeof onProgress !== 'function') return

        let pct = 0
        if (typeof event.progress === 'number' && !Number.isNaN(event.progress)) {
          pct = Math.round(event.progress * 100)
        } else if (event.total && event.total > 0) {
          pct = Math.round((event.loaded * 100) / event.total)
        } else {
          return
        }

        // Cap at 99 until the server responds successfully
        onProgress(Math.min(99, Math.max(0, pct)))
      },
    })

    if (typeof onProgress === 'function') onProgress(100)
    return response.data
  } catch (err) {
    if (
      axios.isCancel?.(err) ||
      err?.code === 'ERR_CANCELED' ||
      err?.name === 'CanceledError' ||
      err?.name === 'AbortError'
    ) {
      const cancelErr = new Error('Upload cancelled')
      cancelErr.cancelled = true
      throw cancelErr
    }

    const status = err?.response?.status
    if (status === 401 && path !== '/api/me' && path !== '/api/login') {
      window.dispatchEvent(new Event('auth:logout'))
    }

    const message =
      err?.response?.data?.error ||
      err?.message ||
      'Failed to upload file'
    throw new Error(message)
  }
}

export async function checkAuth() {
  try {
    const res = await authFetch('/api/me')
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data.authenticated)
  } catch {
    return false
  }
}

export async function logoutRequest() {
  try {
    await authFetch('/api/logout', { method: 'POST' })
  } catch {
    // ignore
  }
}

/** Live share updates over Socket.IO (cookie auth). */
let shareSocket = null

export function connectShareSocket({ onUpdate, onRecentUpdate, onAuthError } = {}) {
  // Reuse one socket across React Strict Mode remounts (avoids WS closed warning)
  if (!shareSocket) {
    shareSocket = io(API_BASE || undefined, {
      path: '/socket.io',
      withCredentials: true,
      // Polling first is more reliable through the Vite proxy; upgrades to WS after
      transports: ['polling', 'websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 8,
    })
  }

  const socket = shareSocket

  const handleUpdate = (payload) => {
    if (typeof onUpdate === 'function') onUpdate(payload)
  }

  const handleConnect = () => {
    socket.emit('share:sync')
  }

  const handleConnectError = (err) => {
    const message = err?.message || ''
    if (/auth/i.test(message) && typeof onAuthError === 'function') {
      onAuthError(err)
    }
  }

  socket.on('share:update', handleUpdate)
  socket.on('connect', handleConnect)
  socket.on('connect_error', handleConnectError)

  const handleRecent = (payload) => {
    if (typeof onRecentUpdate === 'function') onRecentUpdate(payload)
  }
  socket.on('recent:update', handleRecent)

  if (socket.connected) {
    socket.emit('share:sync')
  }

  return {
    disconnect() {
      socket.off('share:update', handleUpdate)
      socket.off('connect', handleConnect)
      socket.off('connect_error', handleConnectError)
      socket.off('recent:update', handleRecent)
    },
    forceDisconnect() {
      socket.off('share:update', handleUpdate)
      socket.off('connect', handleConnect)
      socket.off('connect_error', handleConnectError)
      socket.off('recent:update', handleRecent)
      socket.disconnect()
      shareSocket = null
    },
  }
}

export function disconnectShareSocket() {
  if (!shareSocket) return
  shareSocket.removeAllListeners()
  shareSocket.disconnect()
  shareSocket = null
}
