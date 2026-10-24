#!/usr/bin/env bash
# =============================================================================
# backup_data.sh — Backup state Komik Hub (durable data, bukan cache).
#
# Fungsi: snapshot direktori state (users/, progress/, read/, downloads/,
# state.json) ke folder backup ber-timestamp, lalu retensi N backup terbaru.
#
# Data yang DIKECUALIKAN: imgcache/ (cache gambar, regenerable dari sumber).
#
# Pemakaian:
#   ./backup_data.sh                     # backup sekarang (retensi default 12)
#   ./backup_data.sh --retain 20         # simpan 20 backup terbaru
#   ./backup_data.sh --verify            # backup + validasi tiap file JSON
#   ./backup_data.sh --dry-run           # tampilkan apa yang akan disalin, tanpa menyalin
#   ./backup_data.sh --restore <dir>     # restore dari backup dir (copy balik)
#
# Override path lewat env (urutan prioritas sama seperti server):
#   KOMIKU_USERS_DIR   (paling kuat)
#   KOMIKU_NOTIF_DIR
#   default: ./data  (relatif CWD script)
#   KOMIKU_BACKUP_DIR (default: <repo>/backups)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- resolve data dir (mengikuti prioritas env server) ---
if [[ -n "${KOMIKU_USERS_DIR:-}" ]]; then
  DATA_DIR="$KOMIKU_USERS_DIR"
elif [[ -n "${KOMIKU_NOTIF_DIR:-}" ]]; then
  DATA_DIR="$KOMIKU_NOTIF_DIR"
else
  DATA_DIR="$REPO_DIR/data"
fi

BACKUP_ROOT="${KOMIKU_BACKUP_DIR:-$REPO_DIR/backups}"
RETAIN=12
VERIFY=0
DRY_RUN=0
RESTORE_FROM=""

# --- parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --retain) RETAIN="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --restore) RESTORE_FROM="$2"; shift 2 ;;
    *) echo "argumen tak dikenal: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$RESTORE_FROM" ]]; then
  if [[ ! -d "$RESTORE_FROM" ]]; then
    echo "ERROR: direktori backup tidak ada: $RESTORE_FROM" >&2
    exit 2
  fi
  echo "Restore dari: $RESTORE_FROM -> $DATA_DIR"
  rm -rf "$DATA_DIR/users" "$DATA_DIR/progress" "$DATA_DIR/read" "$DATA_DIR/downloads" "$DATA_DIR/state.json"
  mkdir -p "$DATA_DIR"
  cp -r "$RESTORE_FROM/users" "$DATA_DIR/" 2>/dev/null || true
  cp -r "$RESTORE_FROM/progress" "$DATA_DIR/" 2>/dev/null || true
  cp -r "$RESTORE_FROM/read" "$DATA_DIR/" 2>/dev/null || true
  cp -r "$RESTORE_FROM/downloads" "$DATA_DIR/" 2>/dev/null || true
  cp "$RESTORE_FROM/state.json" "$DATA_DIR/" 2>/dev/null || true
  echo "Restore selesai."
  exit 0
fi

# --- validasi ---
if [[ ! -d "$DATA_DIR" ]]; then
  echo "ERROR: data dir tidak ada: $DATA_DIR" >&2
  echo "Set KOMIKU_USERS_DIR / KOMIKU_NOTIF_DIR bila server pakai dir berbeda." >&2
  exit 2
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DATA_DIR   = $DATA_DIR"
  echo "BACKUP_ROOT = $BACKUP_ROOT"
  echo "RETAIN     = $RETAIN"
  echo "Subdir yang akan disalin: users/ progress/ read/ downloads/ state.json"
  echo "Dikecualikan: imgcache/ (cache regenerable)"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"

echo "Backup: $DATA_DIR -> $DEST"
mkdir -p "$DEST"

copy_dir() {
  local sub="$1"
  if [[ -d "$DATA_DIR/$sub" ]]; then
    cp -r "$DATA_DIR/$sub" "$DEST/"
    echo "  + $sub/ ($(du -sh "$DATA_DIR/$sub" | cut -f1))"
  else
    echo "  ~ $sub/ (kosong, dilewati)"
  fi
}

copy_dir users
copy_dir progress
copy_dir read
copy_dir downloads

if [[ -f "$DATA_DIR/state.json" ]]; then
  cp "$DATA_DIR/state.json" "$DEST/"
  echo "  + state.json"
fi

# --- verify: pastikan tiap .json di backup bisa di-parse ---
if [[ "$VERIFY" == "1" ]]; then
  echo "Verifikasi JSON backup..."
  BAD=0
  while IFS= read -r f; do
    # Normalisasi path untuk Python native (Windows tak kenal /tmp/... MSYS).
    if command -v cygpath >/dev/null 2>&1; then
      native_f="$(cygpath -w "$f")"
    else
      native_f="$f"
    fi
    if ! python -c "import json,sys; json.load(open(sys.argv[1], encoding='utf-8'))" "$native_f" 2>/dev/null; then
      echo "  KORUP: $f" >&2
      BAD=1
    fi
  done < <(find "$DEST" -name "*.json")
  if [[ "$BAD" == "1" ]]; then
    echo "ERROR: ada file JSON korup di backup — backup DIANGGAP GAGAL." >&2
    exit 3
  fi
  echo "  Semua file JSON valid."
fi

# --- retensi: buang backup paling lama melewati RETAIN ---
ALL=($(ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | sort || true))
COUNT=${#ALL[@]}
if [[ "$COUNT" -gt "$RETAIN" ]]; then
  TO_DELETE=$((COUNT - RETAIN))
  for ((i=0; i<TO_DELETE; i++)); do
    echo "  retensi: hapus ${ALL[$i]}"
    rm -rf "${ALL[$i]}"
  done
fi

echo "Selesai. Backup terbaru: $DEST"
echo "Jumlah backup tersimpan: $(ls -1d "$BACKUP_ROOT"/*/ | wc -l)"
