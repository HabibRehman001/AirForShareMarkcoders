import React, { useState, useCallback, useEffect, useRef } from 'react'
import Alert from './alert.jsx'
import { apiUrl } from '../api.js'

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const Airforshare = () => {
    const [text, setText] = useState('')
    const [sharedText, setSharedText] = useState('')
    const [files, setFiles] = useState([])
    const [selectedFiles, setSelectedFiles] = useState([])
    const [alert, setAlert] = useState({ message: '', type: 'success' })
    const [uploading, setUploading] = useState(false)
    const [uploadingFiles, setUploadingFiles] = useState(false)
    const fileInputRef = useRef(null)

    const showAlert = useCallback((message, type = 'success') => {
        setAlert({ message, type })
    }, [])

    const closeAlert = useCallback(() => {
        setAlert({ message: '', type: 'success' })
    }, [])

    const fetchShared = useCallback(async () => {
        try {
            const res = await fetch(apiUrl('/api/text'))
            if (!res.ok) throw new Error('Failed to fetch')
            const data = await res.json()
            setSharedText(data.text || '')
            setFiles(data.files || [])
        } catch {
            // silent on poll failures
        }
    }, [])

    useEffect(() => {
        fetchShared()
        const interval = setInterval(fetchShared, 3000)
        return () => clearInterval(interval)
    }, [fetchShared])

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
            setFiles(data.files || [])
            setText('')
            showAlert('Text uploaded successfully', 'success')
        } catch (err) {
            console.error('Upload failed:', err)
            showAlert('Failed to upload text', 'error')
        } finally {
            setUploading(false)
        }
    }

    const handleFileSelect = (e) => {
        const list = Array.from(e.target.files || [])
        setSelectedFiles(list)
    }

    const handleFileUpload = async () => {
        if (!selectedFiles.length) {
            showAlert('Please choose a file first', 'warning')
            return
        }

        const tooBig = selectedFiles.find((file) => file.size > 10 * 1024 * 1024)
        if (tooBig) {
            showAlert('File too large (max 10MB)', 'warning')
            return
        }

        setUploadingFiles(true)
        try {
            const formData = new FormData()
            selectedFiles.forEach((file) => formData.append('files', file))

            const res = await fetch(apiUrl('/api/upload-file'), {
                method: 'POST',
                body: formData,
            })

            const raw = await res.text()
            let data = {}
            if (raw) {
                try {
                    data = JSON.parse(raw)
                } catch {
                    throw new Error(res.ok ? 'Invalid server response' : `Upload failed (${res.status})`)
                }
            }

            if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`)

            setFiles(data.files || [])
            setSelectedFiles([])
            if (fileInputRef.current) fileInputRef.current.value = ''
            showAlert('File uploaded successfully', 'success')
        } catch (err) {
            console.error('File upload failed:', err)
            showAlert(err.message || 'Failed to upload file', 'error')
        } finally {
            setUploadingFiles(false)
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

    const handleDownload = (file) => {
        window.open(apiUrl(`/api/files/${file.id}/download`), '_blank')
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

                    <div className='share-block'>
                        <label className='share-label' htmlFor='share-file'>
                            Share file
                        </label>
                        <div className='input-row file-row'>
                            <input
                                id='share-file'
                                ref={fileInputRef}
                                type='file'
                                multiple
                                onChange={handleFileSelect}
                                disabled={uploadingFiles}
                                className='file-input'
                            />
                            <button
                                className='btn btn-primary'
                                onClick={handleFileUpload}
                                disabled={uploadingFiles || !selectedFiles.length}
                            >
                                {uploadingFiles ? 'Uploading…' : 'Upload file'}
                            </button>
                        </div>
                        {selectedFiles.length > 0 && (
                            <p className='file-hint'>
                                {selectedFiles.length} file(s) selected
                            </p>
                        )}
                    </div>

                    <div className='share-divider' />

                    <div className='share-block'>
                        <label className='share-label' htmlFor='share-output'>
                            Received text
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

                    <div className='share-block'>
                        <label className='share-label'>Received files</label>
                        {files.length === 0 ? (
                            <p className='file-empty'>No shared files yet</p>
                        ) : (
                            <ul className='file-list'>
                                {files.map((file) => (
                                    <li key={file.id} className='file-item'>
                                        <div className='file-info'>
                                            <span className='file-name'>{file.name}</span>
                                            <span className='file-size'>{formatBytes(file.size)}</span>
                                        </div>
                                        <button
                                            className='btn btn-ghost btn-small'
                                            onClick={() => handleDownload(file)}
                                        >
                                            Download
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}

export default Airforshare
