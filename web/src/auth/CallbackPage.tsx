import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import * as kc from './keycloak'

export function CallbackPage() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    kc.handleCallback()
      .then((redirect) => {
        if (redirect) {
          window.location.href = redirect
        } else {
          navigate('/login', { replace: true })
        }
      })
      .catch((err) => {
        setError((err as Error)?.message || '登录回调失败')
      })
  }, [navigate])

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-ccdash-bg">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
          <a href="/login" className="text-cyan-400 hover:underline text-sm">返回登录</a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center h-screen bg-ccdash-bg">
      <div className="text-slate-400 text-sm">正在完成登录...</div>
    </div>
  )
}
