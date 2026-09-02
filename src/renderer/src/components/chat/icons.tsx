import React from 'react'

interface IconProps {
  className?: string
}

export function SearchIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  )
}

export function RefreshIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 12a8 8 0 0 1-13.7 5.7" />
      <path d="M4 12A8 8 0 0 1 17.7 6.3" />
      <path d="M17.5 3.5v3h-3" />
      <path d="M6.5 20.5v-3h3" />
    </svg>
  )
}

export function ExportIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3v11" />
      <path d="m8 10 4 4 4-4" />
      <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

export function MoreIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </svg>
  )
}

export function AiIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3l1.5 5 5 1.5-5 1.5-1.5 5-1.5-5-5-1.5 5-1.5L12 3Z" />
      <path d="M18 15l.8 2.4 2.2.6-2.2.7L18 22l-.8-2.3-2.2-.7 2.2-.6L18 15Z" />
    </svg>
  )
}

export function SendIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m4 5 16 7-16 7 3-7-3-7Z" />
      <path d="M7 12h13" />
    </svg>
  )
}

export function CloseIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  )
}

export function ArrowDownIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function CheckCircleIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="8" />
      <path d="m8.5 12.2 2.2 2.2 4.8-5" />
    </svg>
  )
}

export function HomeIcon({ className }: IconProps): React.ReactElement {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6.5 10.5V19h11v-8.5" />
    </svg>
  )
}
