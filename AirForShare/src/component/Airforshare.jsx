import React, { useState, useCallback, useEffect } from 'react'
import Alert from './alert.jsx'
import { apiUrl } from '../api.js'

const Airforshare = () => {
    const [text, setText] = useState('')
    const [sharedText, setSharedText] = useState('')
    const [alert, setAlert] = useState({ message: '', type: 'success' })
    const [uploading, setUploading] = useState(false)

    const showAlert = useCallback((message, type = 'success') => {
        setAlert({ message, type })
    }, [])

    const closeAlert = useCallback(() => {
        setAlert({ message: '', type: 'success' })
    }, [])

    const fetchSharedText = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/api/text'))
            if (!res.ok) throw new Error('Failed to fetch')
            const data = await res.json()
            setSharedText(data.text || '')
        } catch {
            // silent on first load / poll failures
        }
    }, [])

    useEffect(() => {
        fetchSharedText()
        const interval = setInterval(fetchSharedText, 3000)
        return () => clearInterval(interval)
    }, [fetchSharedText])

    const handleUpload = async () => {
        if (!text.trim()) {
            showAlert('Please enter some text first', 'warning')
            return
        }

        setUploading(true)
        try {
            const res = await fetch(apiUrl('/api/upload'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text.trim() }),
            })
            const data = await res.json()
            if (!res.ok) throw new Error(data.error || 'Upload failed')

            setSharedText(data.text)
            setText('')
            showAlert('Text uploaded successfully', 'success')
        } catch {
            showAlert('Failed to upload text', 'error')
        } finally {
            setUploading(false)
        }
    }

    const handleCopy = async () => {
        if (!sharedText.trim()) {
            showAlert('Nothing to copy yet', 'warning')
            return
        }

        try {
            await navigator.clipboard.writeText(sharedText)
            showAlert('Copied to clipboard', 'success')
        } catch {
            showAlert('Failed to copy text', 'error')
        }
    }

    return (
        <div className='container-wrapper'>
            <Alert
                message={alert.message}
                type={alert.type}
                onClose={closeAlert}
            />

            <div className='container'>
                <div className='content'>
                    <img
                        className='brand-logo'
                        src='/logo.jpg'
                        alt='MarkCoders'
                    />
                    <h1>MarkCoders.Share</h1>
                    <span className='by'>Share Your Text And files <br /> <span className='without'>Without any external connections</span></span>
                </div>
            </div>

            <div className='container-wrapper-child'>
                <div className='share-panel'>
                    <div className='share-block'>
                        <label className='share-label' htmlFor='share-input'>
                            Share text
                        </label>
                        <div className='input-row'>
                            <input
                                id='share-input'
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && !uploading && handleUpload()}
                                type='text'
                                placeholder='Type something…'
                                disabled={uploading}
                            />
                            <button
                                className='btn btn-primary'
                                onClick={handleUpload}
                                disabled={uploading}
                            >
                                {uploading ? 'Uploading…' : 'Upload'}
                            </button>
                        </div>
                    </div>

                    <div className='share-divider' />

                    <div className='share-block'>
                        <label className='share-label' htmlFor='share-output'>
                            Received
                        </label>
                        <textarea
                            id='share-output'
                            className='output'
                            value={sharedText}
                            readOnly
                            placeholder='Shared text will appear here…'
                        />
                        <button
                            className='btn btn-ghost'
                            onClick={handleCopy}
                            disabled={!sharedText}
                        >
                            Copy to clipboard
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

export default Airforshare
