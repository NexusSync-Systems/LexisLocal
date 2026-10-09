#!/usr/bin/env python3
"""Prolnutí vah: (1 − w) × původní model + w × doladěný model (tzv. WiSE-FT).

Po 4. běhu (8. 10. 2026) doladěný model výrazně zlepšil dotazy ve stylu tréninkových dat,
ale na ručně psaných dotazech advokátů ztrácel. Průměr vah obvykle podrží většinu zisku
a vrátí odolnost na jiném stylu dotazů. Výstup je běžný sentence-transformers model.

  python3 merge.py --base BAAI/bge-m3 --ft out/model --w 0.3 0.5 0.7 --out out/
  → out/mix-0.3/, out/mix-0.5/, out/mix-0.7/
"""
import argparse
import json
import os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="BAAI/bge-m3")
    ap.add_argument("--ft", required=True)
    ap.add_argument("--w", type=float, nargs="+", default=[0.3, 0.5, 0.7], help="podíl doladěného modelu")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    import torch
    from sentence_transformers import SentenceTransformer

    base_sd = {k: v.detach().clone().float() for k, v in SentenceTransformer(a.base, device="cpu").state_dict().items()}
    ft = SentenceTransformer(a.ft, device="cpu")
    ft_sd = {k: v.detach().clone().float() for k, v in ft.state_dict().items()}
    missing = set(base_sd) ^ set(ft_sd)
    if missing:
        raise SystemExit(f"!! modely nemají stejné váhy: {sorted(missing)[:5]}")

    for w in a.w:
        mixed = {}
        for k, fv in ft_sd.items():
            bv = base_sd[k]
            mixed[k] = (bv * (1 - w) + fv * w) if fv.is_floating_point() else fv
        ft.load_state_dict(mixed)
        path = os.path.join(a.out, f"mix-{w:g}")
        ft.save(path)
        with open(os.path.join(path, "mix_info.json"), "w", encoding="utf-8") as f:
            json.dump({"base": a.base, "ft": a.ft, "w_ft": w}, f)
        print(f"=== prolnutí w={w:g} → {path}", flush=True)
        del mixed
        torch.cuda.empty_cache() if torch.cuda.is_available() else None


if __name__ == "__main__":
    main()
