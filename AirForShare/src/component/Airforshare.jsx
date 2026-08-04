import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Delete } from 'lucide-react'
import Alert from './alert.jsx'
import { authFetch } from '../api.js'

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const Airforshare = ({ onLogout }) => {
    const [text, setText] = useState('')
    const [sharedText, setSharedText] = useState('')
    const [files, setFiles] = useState([])
    const [selectedFiles, setSelectedFiles] = useState([])
    const [alert, setAlert] = useState({ message: '', type: 'success' })
    const [uploading, setUploading] = useState(false)
    const [uploadingFiles, setUploadingFiles] = useState(false)
    const [fileToDelete, setFileToDelete] = useState(null)
    const [deleting, setDeleting] = useState(false)
    const fileInputRef = useRef(null)

    const showAlert = useCallback((message, type = 'success') => {
        setAlert({ message, type })
    }, [])

    const closeAlert = useCallback(() => {
        setAlert({ message: '', type: 'success' })
    }, [])

    const fetchShared = useCallback(async () => {
        try {
            const res = await authFetch('/api/text')
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
            const res = await authFetch('/api/upload', {
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
            console.error(err)
            showAlert('Failed to upload text', 'error')
        } finally {
            setUploading(false)
        }
    }

    const handleFileSelect = (e) => {
        setSelectedFiles(Array.from(e.target.files || []))
    }

    const handleFileUpload = async () => {
        if (!selectedFiles.length) {
            showAlert('Please choose a file to upload', 'warning')
            return
        }

        const tooBig = selectedFiles.find((file) => file.size > 490 * 1024 * 1024)
        if (tooBig) {
            showAlert('File too large (max 490MB)', 'warning')
            return
        }

        setUploadingFiles(true)
        try {
            const formData = new FormData()
            selectedFiles.forEach((file) => formData.append('files', file))

            const res = await authFetch('/api/upload-file', {
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
            console.error(err)
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

    const handleDownload = async (file) => {
        try {
            const res = await authFetch(`/api/files/${file.id}/download`)
            if (!res.ok) throw new Error('Download failed')
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = file.name
            a.click()
            URL.revokeObjectURL(url)
        } catch {
            showAlert('Failed to download file', 'error')
        }
    }

    const confirmDeleteFile = async () => {
        if (!fileToDelete) return
        setDeleting(true)
        try {
            const res = await authFetch(`/api/files/${fileToDelete.id}`, {
                method: 'DELETE',
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || 'Delete failed')

            setFiles(data.files || [])
            showAlert(`Deleted ${fileToDelete.name}`, 'success')
            setFileToDelete(null)
        } catch (err) {
            console.error(err)
            showAlert(err.message || 'Failed to delete file', 'error')
        } finally {
            setDeleting(false)
        }
    }

    return (
        <div className='container-wrapper'>
            <Alert
                message={alert.message}
                type={alert.type}
                onClose={closeAlert}
            />

            {fileToDelete && (
                <div className='confirm-overlay' role='dialog' aria-modal='true'>
                    <div className='confirm-modal'>
                        <p className='confirm-title'>Delete file?</p>
                        <p className='confirm-text'>
                            Confirm delete the <span>{fileToDelete.name}</span>
                        </p>
                        <div className='confirm-actions'>
                            <button
                                type='button'
                                className='btn btn-ghost'
                                onClick={() => setFileToDelete(null)}
                                disabled={deleting}
                            >
                                Cancel
                            </button>
                            <button
                                type='button'
                                className='btn btn-danger'
                                onClick={confirmDeleteFile}
                                disabled={deleting}
                            >
                                {deleting ? 'Deleting…' : 'Delete'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <button type='button' className='logout-btn' onClick={onLogout}>
                Logout
            </button>

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
                                disabled={uploadingFiles}
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
                                        <div className='file-actions'>
                                            <button
                                                className='btn btn-ghost btn-small'
                                                onClick={() => handleDownload(file)}
                                            >
                                                Download
                                            </button>
                                            <button
                                                type='button'
                                                className='file-delete-btn'
                                                aria-label={`Delete ${file.name}`}
                                                onClick={() => setFileToDelete(file)}
                                            >
                                                <Delete size={18} />
                                            </button>
                                        </div>
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
