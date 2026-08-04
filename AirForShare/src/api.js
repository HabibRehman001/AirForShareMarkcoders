const PROD_API = 'https://airforsharemarkcoders.onrender.com'

const API_BASE = (
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

/** Upload with progress (0–100). Uses XHR because fetch has no upload progress. */
export function uploadWithProgress(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', apiUrl(path))
    xhr.withCredentials = true

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable || typeof onProgress !== 'function') return
      const pct = Math.min(100, Math.round((e.loaded / e.total) * 100))
      onProgress(pct)
    }

    xhr.onload = () => {
      if (xhr.status === 401 && path !== '/api/me' && path !== '/api/login') {
        window.dispatchEvent(new Event('auth:logout'))
      }

      const raw = xhr.responseText || ''
      let data = {}
      if (raw) {
        try {
          data = JSON.parse(raw)
        } catch {
          reject(new Error(xhr.status < 400 ? 'Invalid server response' : `Upload failed (${xhr.status})`))
          return
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        if (typeof onProgress === 'function') onProgress(100)
        resolve(data)
      } else {
        reject(new Error(data.error || `Upload failed (${xhr.status})`))
      }
    }

    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.send(formData)
  })
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
