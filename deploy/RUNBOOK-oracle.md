# Deploy Komik Hub → Oracle Cloud Free Tier (akun Free-only, anti-tagihan)

**Filosofi:** akun Free-only Oracle **tidak punya hubungan tagihan sama sekali** —
tanpa upgrade ke Pay-As-You-Go, kalau resource melebihi batas yang terjadi adalah
**resource dimatikan/di-reclaim, bukan ditagih**. Ini satu-satunya opsi yang aman
untuk "sering lupa cabut kartu": tidak ada langganan untuk dilupakan, tidak ada
jalur tagihan otomatis. Kartu hanya dipakai verifikasi identitas sekali (hold $1,
dikembalikan bank 3–5 hari).

> **PENTING — jangan upgrade ke PAYG.** Itu satu-satunya hal yang membuka
> kemungkinan tagihan. Cukup akun Free-only. Konsekuensinya: kapasitas ARM kadang
> "Out of host capacity" saat buat VM — ulangi berkala, atau pakai AD lain.

## Fakta (terverifikasi 2026-10-16)

| Aspek | Nilai |
|---|---|
| Kartu | Verifikasi saja — hold **$1** (bukan $100; $100 hanya saat upgrade PAYG) |
| ARM A1 | **2 OCPU / 12 GB** (dipangkas Juni 2026 dari 24 GB) — masih besar untuk app kita |
| Disk | Boot + block volume total 200 GB, gratis |
| Egress | **10 TB/bulan** — tidak akan kena untuk pemakaian pribadi |
| Idle reclaim | VM di-reclaim bila CPU+net+mem <15% selama 7 hari → **dimatikan oleh keepalive script** |
| Satu-satunya risiko | Resource dimatikan kalau lewat batas (bukan tagihan) |

## Langkah 1 — Daftar (kamu, ~10 menit)

1. https://www.oracle.com/cloud/free/ → **Start for free**
2. Isi email + **Home Region: Singapore** (⚠️ tidak bisa diubah setelah daftar;
   pilih Singapore, jangan Batam kalau stok ARM di sana belum jelas)
3. Verifikasi kartu: hold $1 (sementara, hilang sendiri). **JANGAN pilih
   "Upgrade to Pay As You Go"** di langkah mana pun — biarkan akun tetap Free.
4. Selesai → masuk console.

## Langkah 2 — Buat VM (kamu, ~5 menit)

Compute → Instances → **Create instance**:
- **Image**: Ubuntu 22.04 atau 24.04 (ARM build)
- **Shape**: `VM.Standard.A1.Flex` → **2 OCPU, 12 GB** (semua jatah)
- **SSH keys**: pilih **Paste public key** → paste isi file ini:
  ```
  C:\Users\LENOVO LEGION\.ssh\id_ed25519.pub
  ```
  (isi lengkapnya: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICtS6XYxBbRjj8lGJSXGvVEVNVLn9H/ZdZ4L56b0npkp komik-hub-oracle`)
- **Boot volume**: default (sampai 200 GB gratis kalau mau)
- Create. Kalau "Out of host capacity": ganti Availability Domain, atau retry
  berkala (aku bisa buatkan loop di terminal lokal kalau kamu mau).

## Langkah 3 — Buka port di Security List (kamu, ~2 menit)

VM → **Subnet** → Security Lists → default → **Add Ingress Rules**:
- Rule 1: Source `0.0.0.0/0`, IP Protocol TCP, Destination Port **80**
- Rule 2: Source `0.0.0.0/0`, IP Protocol TCP, Destination Port **443**
- (SSH 22 sudah ada default)

## Langkah 4 — Ambil IP + jalankan setup (aku atau kamu, 1 perintah)

Catat **Public IP** VM (halaman instance). Lalu dari laptop:

```bash
IP=<public-ip-vm>
ssh -i "C:/Users/LENOVO LEGION/.ssh/id_ed25519" ubuntu@$IP \
  "SITE_HOST=$IP.sslip.io BASIC_AUTH_USER=alif BASIC_AUTH_HASH='<hash>' sh -s" \
  < D:/project/deploy/vm-setup.sh
```

- `<hash>` = `$2a$14$F9fNnGPvSzQpTYVT2RdmGOo5K4ejBAOv006FlWkvCx2o8JHZ7kEKa`
  (password: `komik-m31LUI6u` — sudah tersimpan di RUNBOOK-render.md)
- `sslip.io` = trik DNS gratis: `<IP>.sslip.io` otomatis resolve ke IP itu,
  sehingga Caddy bisa dapat **HTTPS Let's Encrypt gratis** tanpa beli domain.
  Kalau nanti punya domain sendiri, ganti `SITE_HOST` dan re-run.

Script itu melakukan semuanya: Docker, firewall, pull image ARM64 dari GHCR,
run container dengan volume persisten `/srv/komik-hub/data`, dan memasang
**timer keepalive anti-reclaim** (stress-ng ringan tiap 30 menit).

## Langkah 5 — Verifikasi (1 menit)

```bash
BASE=https://<IP>.sslip.io
curl -s -o /dev/null -w "healthz %{http_code}\n" $BASE/healthz          # 200
curl -s -o /dev/null -w "noauth %{http_code}\n" $BASE/                   # 401
curl -s -u alif:komik-m31LUI6u $BASE/api/health                          # {"ok":true}
```

Buka di HP: login → baca chapter → gambar termuat. Selesai.

## Prasyarat satu kali: GHCR package visibility = PUBLIC

VM harus bisa pull image tanpa login. Di GitHub:
1. https://github.com/users/alifadwitiyap/packages/container/komik-hub
2. **Package settings** → Danger Zone → **Change visibility** → Public.

(Isi image bukan rahasia: password/hash di-inject sebagai env runtime.)

## Operasional

| Aksi | Perintah (dari laptop) |
|---|---|
| Lihat log | `ssh -i ... ubuntu@$IP 'sudo docker logs --tail 50 komik-hub'` |
| Update app | `ssh ... 'sudo docker pull ghcr.io/alifadwitiyap/komik-hub:latest && sudo docker rm -f komik-hub && <re-run docker run>'` — atau jalankan ulang vm-setup.sh (idempoten) |
| Restart | `ssh ... 'sudo docker restart komik-hub'` |
| Hapus semua | `ssh ... 'sudo docker rm -f komik-hub && sudo rm -rf /srv/komik-hub'` |

## Kalau kamu ingin MATI TOTAL tanpa biaya apa pun

1. Hentikan instance (boleh; data boot volume tetap ada)
2. Bahkan dibiarkan hidup pun: **akun Free-only tidak bisa ditagih** — risiko
   maksimalnya resource dimatikan Oracle. Tidak ada utang, tidak ada langganan.

## Kenapa bukan yang lain (dengan kartu tersedia)

| Opsi | Masalah untuk "sering lupa" |
|---|---|
| Render (kartu) | Overage bandwidth **$0.15/GB ditagih otomatis** ke kartu |
| Railway (kartu) | Usage meter berjalan terus; lewat $1 → ditagih |
| Fly.io | Pay-as-you-go murni, meter per detik |
| Oracle PAYG | Bisa ditagih kalau lewat batas — **jangan upgrade** |
| **Oracle Free-only** | **Tidak bisa ditagih sama sekali** ✓ |
