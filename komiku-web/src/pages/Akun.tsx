/**
 * Akun — halaman identitas Komik Hub (username-only, tanpa password).
 *
 * Satu halaman menangani dua keadaan:
 *   - belum masuk → form "Masuk atau daftar" (ketik username → POST /user/claim)
 *   - sudah masuk → username + tautan akun lintas-device + Ganti akun / Keluar
 *
 * `claim` mengembalikan `created`: true = akun BARU. `setUser(u, created)`
 * meneruskan itu ke store favorit/progress yang memilih arah sinkronisasi
 * (created=true → push rak lokal; selain itu → pull server). Lihat spec §5.
 *
 * Halaman ini TIDAK menangani error sebagai crash: username invalid ditolak di
 * klien (aturan sama dengan server) tanpa round-trip; kegagalan jaringan
 * ditampilkan sebagai pesan kecil di bawah field.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  USERNAME_RULE,
  accountLink,
  getUser,
  isValidUsername,
  normalizeUsername,
  setUser,
} from '../account'
import { userApi } from '../api'
import { IconUser } from '../icons'

export default function Akun() {
  // Link akun (?u=…) sudah ditangkap di App (boot) SEBELUM halaman ini render,
  // jadi getUser() di sini sudah mencerminkan identitas dari URL.
  const [username, setUsername] = useState<string | null>(() => getUser())
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const u = normalizeUsername(value)
    if (!isValidUsername(u)) {
      setError(USERNAME_RULE)
      return
    }
    setBusy(true)
    try {
      const res = await userApi.claim(u)
      // created menentukan arah sinkronisasi di store favorit/progress.
      setUser(res.username, res.created)
      setUsername(res.username)
      setValue('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal masuk — coba lagi.')
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    setUser(null)
    setUsername(null)
    setError(null)
  }

  // Ganti akun = lupakan akun aktif (created=null → PULL pada akun berikutnya),
  // lalu tampilkan form lagi. Data akun lama tetap utuh di servernya.
  function switchAccount() {
    setUser(null)
    setUsername(null)
    setError(null)
    setValue('')
  }

  async function copyLink() {
    if (!username) return
    try {
      await navigator.clipboard.writeText(accountLink(username))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Gagal menyalin — salin manual dari tautan di atas.')
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-1 font-display text-xl font-semibold text-ink-100">Akun</h1>
      <p className="mb-6 text-sm text-ink-500">
        Identitas dipakai supaya favorit, notifikasi, unduhan, dan posisi baca
        tersimpan per orang — bukan per device.
      </p>

      {username === null ? (
        <form onSubmit={submit} className="rounded-2xl border border-ink-800 bg-ink-900 p-4">
          <label htmlFor="akun-username" className="mb-2 block text-sm font-medium text-ink-200">
            Masuk atau daftar
          </label>
          <div className="flex gap-2">
            <input
              id="akun-username"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="username"
              className="min-w-0 flex-1 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-amber"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-brand-amber px-4 py-2 text-sm font-semibold text-white transition-opacity active:opacity-80 disabled:opacity-50"
            >
              {busy ? '…' : 'Lanjut'}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-ink-500">
            Belum punya? Ketik nama baru — langsung dibuat. {USERNAME_RULE}.
          </p>
          {error && (
            <p className="mt-2 rounded-xl border border-brand-red/40 bg-brand-red/10 px-3 py-2 text-[12px] text-brand-red">
              {error}
            </p>
          )}
        </form>
      ) : (
        <div className="rounded-2xl border border-ink-800 bg-ink-900 p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-full bg-ink-850 text-ink-300">
              <IconUser className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate font-display text-lg font-semibold text-ink-100">{username}</p>
              <p className="text-[12px] text-ink-500">Sudah masuk</p>
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-1 text-[12px] text-ink-500">Tautan akun (buka di device lain)</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] text-ink-300">
                {accountLink(username)}
              </code>
              <button
                type="button"
                onClick={copyLink}
                className="shrink-0 rounded-xl bg-ink-850 px-3 py-2 text-[12px] font-medium text-ink-200 active:bg-ink-800"
              >
                {copied ? 'Tersalin' : 'Salin'}
              </button>
            </div>
          </div>

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={switchAccount}
              className="rounded-xl border border-ink-700 px-3 py-2 text-sm font-medium text-ink-200 active:bg-ink-850"
            >
              Ganti akun
            </button>
            <button
              type="button"
              onClick={logout}
              className="rounded-xl border border-brand-red/40 px-3 py-2 text-sm font-medium text-brand-red active:bg-brand-red/10"
            >
              Keluar
            </button>
          </div>
          {error && (
            <p className="mt-2 rounded-xl border border-brand-red/40 bg-brand-red/10 px-3 py-2 text-[12px] text-brand-red">
              {error}
            </p>
          )}
        </div>
      )}

      <p className="mt-6 text-[12px] text-ink-500">
        Tanpa password: siapa pun yang tahu username-mu bisa masuk. Situs ini
        sudah di balik satu password bersama, jadi halaman ini efektifnya undangan.
      </p>

      <Link to="/rak" className="mt-4 inline-block text-sm font-medium text-brand-amber">
        Lihat rak →
      </Link>
    </div>
  )
}
