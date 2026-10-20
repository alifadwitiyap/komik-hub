"""e2e_cleanup.py — hapus state akun throwaway setelah E2E selesai.

Setiap skrip E2E yang mendaftarkan akun sementara (`POST /api/user/claim`)
meninggalkan file state-nya di server: `data/users/<u>.json` plus
`data/progress/<u>.json` dan `data/read/<u>.json` (server yang menulis dua
terakhir saat browser berinteraksi). Tanpa cleanup, tiap run menumpuk file
— 121 file di `data/users/` hanya dari beberapa dozen run read-mark.

File state TIDAK bisa dihapus lewat API: server tak punya endpoint
"hapus akun". Jadi hapus langsung dari disk.

Sisa-sisa: `data/read/<u>.json` ditulis server tiap mark, dan `notif.rs`
menyimpan state akun di memory (`NotifStore.state`) — file yang dihapus
tak akan dibaca lagi, tapi state di memory tetap hidup sampai server
restart. Itu aman: akunnya throwaway.

Yang TIDAK boleh dihapus: akun non-e2e (`alif-11`, `dltest`, dst). Fungsi
ini hanya menyentuh username yang benar-benar dibuat skrip yang memanggilnya.
"""
import glob
import os

# Direktori data server. Default: ../komiku-server/data (repo D:/project).
SERVER_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "komiku-server")
)


def cleanup_accounts(*usernames, server_root: str = SERVER_ROOT) -> list[str]:
    """Hapus file state akun throwaway. Kembalikan daftar file yang dihapus."""
    removed: list[str] = []
    for user in usernames:
        if not user:
            continue
        for sub in ("users", "progress", "read"):
            path = os.path.join(server_root, "data", sub, user + ".json")
            try:
                os.remove(path)
                removed.append(path)
            except OSError:
                pass
    return removed


# Username yang dibuat skrip ini. Prefix yang sama dipakai >1 skrip
# (mis. `e2erm` dipakai readmark_e2e DAN readmark_marathon_e2e), jadi
# cleanup berbasis prefix bisa saling hapus kalau suite jalan paralel.
# Karena itu skrip mendaftarkan usernameNYA di sini, dan cleanup hanya
# menyentuh yang terdaftar.
CLAIMED: list[str] = []


def track(username: str) -> str:
    """Daftarkan username throwaway yang dibuat skrip ini."""
    CLAIMED.append(username)
    return username


def cleanup_claimed(server_root: str = SERVER_ROOT) -> list[str]:
    """Hapus file state semua akun yang didaftarkan `track()`."""
    return cleanup_accounts(*CLAIMED, server_root=server_root)


def cleanup_pattern(pattern: str, server_root: str = SERVER_ROOT) -> list[str]:
    """Hapus file state semua akun yang namanya cocok `pattern` (glob).

    HATI-HATI: hanya untuk prefix yang dijamin throwaway (mis. `e2e`).
    """
    removed: list[str] = []
    for sub in ("users", "progress", "read"):
        for path in glob.glob(os.path.join(server_root, "data", sub, pattern)):
            try:
                os.remove(path)
                removed.append(path)
            except OSError:
                pass
    return removed
