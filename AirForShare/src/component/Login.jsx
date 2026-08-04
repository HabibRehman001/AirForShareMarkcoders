import React, { useState } from 'react'
import { apiUrl } from '../api.js'

const Login = ({ onSuccess }) => {
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (e) => {
        e.preventDefault()
        setError('')

        if (!username.trim() || !password) {
            setError('Enter username and password')
            return
        }

        setLoading(true)
        try {
            const res = await fetch(apiUrl('/api/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    username: username.trim(),
                    password,
                }),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'Login failed')
            onSuccess(data.username)
        } catch (err) {
            setError(err.message || 'Login failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className='login-page'>
            <form className='login-card' onSubmit={handleSubmit}>
                <img className='login-logo' src='/logo.jpg' alt='MarkCoders' />
                <h1>MarkCoders.Share</h1>
                <p className='login-sub'>Sign in to continue</p>

                <label className='share-label' htmlFor='login-user'>Username</label>
                <input
                    id='login-user'
                    className='login-input'
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete='username'
                    placeholder='Username'
                    disabled={loading}
                />

                <label className='share-label' htmlFor='login-pass'>Password</label>
                <input
                    id='login-pass'
                    className='login-input'
                    type='password'
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete='current-password'
                    placeholder='Password'
                    disabled={loading}
                />

                {error && <p className='login-error'>{error}</p>}

                <button className='btn btn-primary login-btn' type='submit' disabled={loading}>
                    {loading ? 'Signing in…' : 'Login'}
                </button>
            </form>
        </div>
    )
}

export default Login
