#!/usr/bin/env python3
"""Vybere z metrics.json (evaluate.py) nejlepšího kandidáta k převodu do GGUF.

Kritérium: MRR@10 na ruční zlaté sadě s hybridem jako na serveru (`gold+hybrid`);
při shodě rozhoduje R@1. Původní model se do výběru nepočítá — jen se s ním srovná.
Výstup (JSON na stdout i do --out): {"chosen": cesta, "metric": …, "base_metric": …, "better_than_base": bool}

  python3 choose_model.py --metrics out/metrics.json --base BAAI/bge-m3 --out out/chosen.json
"""
import argparse
import json

KEY = "gold+hybrid"


def score(m):
    x = (m or {}).get(KEY) or {}
    return (x.get("MRR@10", -1), x.get("R@1", -1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metrics", required=True)
    ap.add_argument("--base", default="BAAI/bge-m3")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    res = json.load(open(a.metrics, encoding="utf-8"))
    cands = {k: v for k, v in res.items() if k != a.base and not k.startswith("(")}
    if not cands:
        raise SystemExit("!! žádný kandidát v metrics.json")
    best = max(cands, key=lambda k: score(cands[k]))
    out = {"chosen": best, "criterion": KEY + " MRR@10, pak R@1",
           "metric": cands[best].get(KEY), "base_metric": res.get(a.base, {}).get(KEY),
           "all": {k: score(v) for k, v in cands.items()}}
    out["better_than_base"] = score(cands[best]) > score(res.get(a.base))
    s = json.dumps(out, ensure_ascii=False, indent=1)
    print(s)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(s)


if __name__ == "__main__":
    main()
