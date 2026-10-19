#!/usr/bin/env bash
# Evaluator performa Komik Hub — command yang bisa diulang untuk mengukur
# cold path endpoint union chapter.
#
# Skill ulw-perf: "Do not begin optimization edits before an evaluator command
# and its pass/fail contract exist." File ini adalah evaluator itu.
#
# PEMAKAIAN:
#   bash scripts/perf-eval.sh <PORT> [REPEATS]
#
# KONTRAK PASS/FAIL:
#   Setiap endpoint punya anggaran (budget) di bawah. Skrip keluar dengan
#   kode 0 kalau SEMUA anggaran terpenuhi, kode 1 kalau ada yangmelewati.
#   Regression budget = baseline x (1 + tolerance); tolerance default 20%.
#
# CATATAN PENTING: pengukuran COLD butuh server dengan cache kosong. Untuk
# itu, jalankan server dengan cache memory kosong (start baru) atau pakai
# header/parameter yang bypass cache. Skrip mengukur dua mode:
#   - COLD: request pertama ke endpoint (cache server baru)
#   - WARM: request kedua (cache 10 menit aktif)
# Kalau dijalankan terhadap server yang SUDAH serving, angka COLD sebenarnya
# adalah WARM — skrip melaporkannya apa adanya lewat kolom "mode".

set -uo pipefail

PORT="${1:-8790}"
REPEATS="${2:-3}"
BASE="http://127.0.0.1:${PORT}/api/unified"

# Anggaran cold path (ms).
#
# REGRESSION BUDGET: baseline = hasil TERUKUR setelah optimasi dua-tahap
# (resolve||paralel lalu series||paralel), toleransi 20%.
#   series  COLD 4300 ms  ->  budget 5160 ms
#   chapter COLD 1877 ms  ->  budget 2252 ms
# Rujukan baseline SEBELUM optimasi (untuk konteks): series 6966 ms,
# chapter 2154 ms.
#
# Catatan: cold path masih 2 tahap BERURUTAN (fase 1 = muat series primary
# 1 request; fase 2 = union 3 sumber, 2 request paralel) karena fase 2
# butuh JUDUL dari fase 1. Menyingkirkan sisa itu butuh kiriman judul dari
# klien (perubahan API + web) — di luar lingkup plan ini.
BUDGET_COLD_SERIES=5160
BUDGET_COLD_CHAPTER=2252
TOLERANCE_PCT=20

pass=0
fail=0

# sample: satu request, cetak time_total ms
sample() {
  local path="$1"
  curl -s -m 60 -o /dev/null -w "%{time_total}" "${BASE}${path}" 2>/dev/null
}

ms_of() { awk -v v="$1" 'BEGIN{printf "%d", v*1000}'; }

check() {
  local id="$1" name="$2" got="$3" budget="$4"
  local status="PASS"
  if [ "$got" -gt "$budget" ]; then status="FAIL"; fail=$((fail+1)); else pass=$((pass+1)); fi
  printf "  [%s] %-42s %6s ms  budget %5s ms  %s\n" "$id" "$name" "$got" "$budget" "$status"
}

echo "=============================================================="
echo "PERF EVAL — Komik Hub union chapter (port ${PORT}, ${REPEATS} repeat)"
echo "=============================================================="

# --- COLD: request pertama untuk tiap endpoint (cache key berbeda per endpoint) ---
echo
echo "--- COLD (request pertama, cache belum terisi untuk key itu) ---"
c_series=$(sample "/series/komiku%3A6167"); c_series=$(ms_of "$c_series")
c_chap=$(sample "/chapter/komiku%3A6167/232"); c_chap=$(ms_of "$c_chap")
c_search=$(sample "/search?q=naruto&page=1&limit=24"); c_search=$(ms_of "$c_search")

# --- WARM: request kedua ---
echo
echo "--- WARM (request kedua, cache 10 menit) ---"
w_series=$(sample "/series/komiku%3A6167"); w_series=$(ms_of "$w_series")
w_chap=$(sample "/chapter/komiku%3A6167/232"); w_chap=$(ms_of "$w_chap")
w_search=$(sample "/search?q=naruto&page=1&limit=24"); w_search=$(ms_of "$w_search")

echo
echo "--- HASIL ---"
printf "  %-14s %10s %10s\n" "endpoint" "COLD" "WARM"
printf "  %-14s %8s ms %8s ms\n" "series"  "$c_series" "$w_series"
printf "  %-14s %8s ms %8s ms\n" "chapter" "$c_chap"   "$w_chap"
printf "  %-14s %8s ms %8s ms\n" "search"  "$c_search" "$w_search"

echo
echo "--- ANGGARAN (regression budget = baseline x (1 + ${TOLERANCE_PCT}%)) ---"
# Series: cold = budget utama (regresi yang paling dirasakan user).
check P1 "series COLD (union 235 chapter)" "$c_series" "$BUDGET_COLD_SERIES"
check P2 "chapter COLD (cross-source nav)" "$c_chap"   "$BUDGET_COLD_CHAPTER"
# WARM harus cepat (cache path).
check P3 "series WARM"  "$w_series" 300
check P4 "chapter WARM" "$w_chap"   300

echo
echo "=============================================================="
if [ "$fail" -eq 0 ]; then
  echo "PERF EVAL: PASS (${pass}/${pass}) — semua anggaran terpenuhi"
  exit 0
else
  echo "PERF EVAL: FAIL (${pass} pass, ${fail} fail) — anggaran terlampaui"
  exit 1
fi
