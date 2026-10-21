# Perf Reader Baseline — Komik Hub (2026-10-21)

**Lane:** P4 (`ulw-perf` skill) · **Date:** 2026-10-21 · **Status:** MEASURED → GATED

## Environment & Workload
- Network: slow3g @400kbps, 400ms latency
- Viewport: 390×844, DPR=2, mobile=true
- Chapter: `/baca/komiku:6167/232` (~30 pages)
- Harness: `python scripts/perf_reader.py --profile slow3g --runs 3`

## Metrics & Budgets (cold load)
| Metric | Definition | Baseline | Budget (max) | Tolerance |
|--------|------------|----------|--------------|-----------|
| fcp_ms | First paint | 1664 ms | 2500 ms | +50% |
| page1_ms | Page 1 visible | 7177 ms | 12000 ms | +67% |
| img_kb | Image bytes/page1 | 72 KB | 420 KB | +480% |
| cls | Cumulative layout shift | 0.0001 | 0.02 | +200× |

## Warm / repeat visit (SW enabled)
| Metric | Baseline | Budget | Rationale |
|--------|----------|--------|-----------|
| repeat_ms | 122 ms | 250 ms | Must feel instant |
| page1_ms | 4638 ms | 8000 ms | Cached images still wait for layout |

## Next chapter warm
| Metric | Baseline | Budget | Notes |
|--------|----------|--------|-------|
| next_ms | 338 ms | 500 ms | Prefetch warmed shell + first image |

## Failure Modes
- FCP > 2500 ms → check JS bundle size, async chunks, skeleton visibility
- Page1 > 12000 ms → verify image slot queue limits and prefetch single-width (900px)
- ImgKB > 420 → wrong srcset sizes or proxy resize params
- CLS > 0.02 → missing intrinsic dimensions on images
- Warm next > 500 ms → prefetch hook didn't fire at end-of-scroll + idle fallback

## Reproduce locally
```bash
cd komiku-web
npm run build
python scripts/perf_reader.py --profile slow3g --runs 3 --verbose
```

## CI Gate (GitHub Actions snippet)
```yaml
- name: Performance Budget — Reader Cold
  working-directory: komiku-web
  run: python scripts/perf_reader.py --profile slow3g --runs 3 || exit 1
```

---
Last updated: 2026-10-21 08:15 UTC
