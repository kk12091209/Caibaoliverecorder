export function Mark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="36" r="18" fill="#f8e6ea" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M21 32.5c3.4-7 7.6-9.4 11-9.4s7.6 2.4 11 9.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M26.5 30.2c1.2-3 2.6-4.2 4-4.2M37.5 26c1.4 0 2.8 1.2 4 4.2"
        fill="none"
        stroke="#b94d6a"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M47.2 13.2l1.15 2.35 2.55.25-1.95 1.7.6 2.5-2.35-1.25-2.35 1.25.6-2.5-1.95-1.7 2.55-.25z"
        fill="#b94d6a"
      />
      <circle cx="18" cy="16" r="1.15" fill="#c4a07a" />
    </svg>
  )
}
