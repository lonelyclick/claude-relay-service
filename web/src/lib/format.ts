export function fmtTokens(value: number): string {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M'
  if (value >= 1_000) return (value / 1_000).toFixed(1) + 'K'
  return String(value)
}

export function fmtNum(value: number): string {
  return value.toLocaleString()
}

function formatGroupedInteger(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function fmtMoneyMicros(value: string | number | bigint, currency = 'USD'): string {
  const raw = typeof value === 'bigint' ? value.toString() : String(value ?? '0').trim()
  if (!/^-?\d+$/.test(raw)) {
    return `${currency} 0.00`
  }

  const negative = raw.startsWith('-')
  const digits = negative ? raw.slice(1) : raw
  const padded = digits.padStart(7, '0')
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, '') || '0'
  const fraction = padded.slice(-6).replace(/0+$/, '')
  const amount = `${formatGroupedInteger(whole)}${fraction ? `.${fraction}` : '.00'}`

  if (currency === 'USD') {
    return `${negative ? '-' : ''}$${amount}`
  }
  if (currency === 'CNY') {
    return `${negative ? '-' : ''}¥${amount}`
  }
  return `${negative ? '-' : ''}${currency} ${amount}`
}

function toTimestamp(value: string | number | Date): number {
  if (value instanceof Date) {
    return value.getTime()
  }
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  const numeric = Number(value)
  if (!Number.isNaN(numeric) && value.trim() !== '') {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
  }
  return new Date(value).getTime()
}

export function timeAgo(value: string | number | Date): string {
  const timestamp = toTimestamp(value)
  if (!Number.isFinite(timestamp)) {
    return '—'
  }
  const diffMs = Date.now() - timestamp
  const future = diffMs < 0
  const seconds = Math.floor(Math.abs(diffMs) / 1000)
  if (seconds < 60) return future ? 'in <1m' : 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`
  const days = Math.floor(hours / 24)
  return future ? `in ${days}d` : `${days}d ago`
}

export function fmtShanghaiDateTime(value: string | number | Date): string {
  const timestamp = toTimestamp(value)
  if (!Number.isFinite(timestamp)) {
    return '—'
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))

  const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second} GMT+8`
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString()
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const half = Math.floor((maxLength - 3) / 2)
  return value.slice(0, half) + '...' + value.slice(-half)
}
