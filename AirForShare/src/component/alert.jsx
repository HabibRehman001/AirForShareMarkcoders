import React, { useEffect } from 'react'

const Alert = ({ message, type = 'success', onClose }) => {
    useEffect(() => {
        if (!message) return
        const timer = setTimeout(onClose, 2800)
        return () => clearTimeout(timer)
    }, [message, onClose])

    if (!message) return null

    return (
        <div className={`alert alert--${type}`} role="status">
            <span className="alert__icon" aria-hidden="true">
                {type === 'success' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 6L9 17l-5-5" />
                    </svg>
                )}
                {type === 'error' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M15 9l-6 6M9 9l6 6" />
                    </svg>
                )}
                {type === 'warning' && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 3L2 21h20L12 3z" />
                        <path d="M12 10v5M12 18h.01" />
                    </svg>
                )}
            </span>
            <p className="alert__message">{message}</p>
            <button className="alert__close" onClick={onClose} aria-label="Close">
                ×
            </button>
            <div className="alert__progress" />
        </div>
    )
}

export default Alert
