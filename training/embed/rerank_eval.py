#!/usr/bin/env python3
"""Měření, kolik by vyhledávání přidalo: (1) jiná váha hybridu, (2) přeřazení kandidátů rerankerem.

Po 5. běhu (10. 10. 2026) je správný paragraf v top 10 u 97,6 % ručních dotazů, ale na 1. místě
jen u 71 % — prostor je hlavně v pořadí. Skript nic na serveru nemění, jen měří na stejných sadách
jako evaluate.py (zlatá sada 124 ručních dotazů + odložené testovací dotazy).

  1) váha hybridu: final = α × sémantika + (1 − α) × lexikální shoda, α ∈ --alphas
  2) reranker (cross-encoder, např. BAAI/bge-reranker-v2-m3) přeřadí top K kandidátů z hybridu α=0,8:
       rerank       = jen skóre rerankeru,
       mix β        = β × reranker + (1 − β) × hybrid (obojí min-max normalizované v rámci dotazu).
  3) rychlost rerankeru: ms na dotaz (K kandidátů) na GPU a orientačně na CPU.

Vektory počítá Ollama (stejné GGUF jako server):
  python3 rerank_eval.py --archive …/zakony.tar.gz --pairs pairs/ --models bge-m3 lexis-bge-m3-ft \
      --ollama http://127.0.0.1:11434 --reranker BAAI/bge-reranker-v2-m3 --report out/
"""
import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_corpus, p_text, q_text  # noqa: E402
from evaluate import OllamaEncoder, lexical_matrix, load_sets, rank_metrics  # noqa: E402

GOLD_SETS = ("gold", "gold_advokat", "gold_klient")


def _minmax(x):
    lo, hi = x.min(), x.max()
    return (x - lo) / (hi - lo) if hi > lo else np.zeros_like(x)


def rerank_scores(H, rows, corpus, reranker, k, batch):
    """→ (R, cand): R[i, j] = skóre rerankeru pro kandidáta cand[i, j] (top k z hybridu H)."""
    cand = np.argsort(-H, axis=1)[:, :k]
    pairs = [(r["q"], p_text(corpus[j])) for i, r in enumerate(rows) for j in cand[i]]
    t0 = time.time()
    s = np.asarray(reranker.predict(pairs, batch_size=batch, show_progress_bar=False), dtype=np.float32)
    dt = time.time() - t0
    return s.reshape(len(rows), k), cand, dt


def metrics_from_candidates(order_scores, cand, rel):
    """Metriky, když se pořadí uvnitř top k určuje skórem order_scores (tvar [n, k])."""
    full = np.full((len(rel), cand.max() + 1), -1e9, dtype=np.float32)
    for i in range(len(rel)):
        full[i, cand[i]] = order_scores[i]
    return rank_metrics(full, rel)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True)
    ap.add_argument("--pairs", default="")
    ap.add_argument("--gold", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_queries.json"))
    ap.add_argument("--models", nargs="+", required=True, help="názvy modelů v Ollamě")
    ap.add_argument("--ollama", required=True)
    ap.add_argument("--alphas", type=float, nargs="+", default=[0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1.0])
    ap.add_argument("--base-alpha", type=float, default=0.8, help="hybrid, ze kterého se berou kandidáti pro reranker")
    ap.add_argument("--reranker", default="", help="cross-encoder (sentence-transformers), prázdné = bez rerankeru")
    ap.add_argument("--rerank-k", type=int, nargs="+", default=[10, 20, 30])
    ap.add_argument("--betas", type=float, nargs="+", default=[0.5, 0.7, 0.85])
    ap.add_argument("--test-limit", type=int, default=600, help="max. testovacích dotazů pro reranker (čas)")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--rerank-batch", type=int, default=32)
    ap.add_argument("--report", default="")
    a = ap.parse_args()

    corpus = load_corpus(a.archive)
    idx = {d["id"]: i for i, d in enumerate(corpus)}
    sets = {}
    for sname, rows in load_sets(a.pairs, a.gold).items():
        rows = [r for r in rows if all(x in idx for x in r["rel"])]
        if sname.startswith("test") and len(rows) > a.test_limit:
            rng = np.random.default_rng(0)
            rows = [rows[i] for i in sorted(rng.choice(len(rows), a.test_limit, replace=False))]
        if rows:
            sets[sname] = rows
    print("sady:", {k: len(v) for k, v in sets.items()}, flush=True)
    docs = [p_text(d) for d in corpus]
    L = {s: lexical_matrix([r["q"] for r in rows], docs) for s, rows in sets.items()}
    REL = {s: [{idx[x] for x in r["rel"]} for r in rows] for s, rows in sets.items()}

    reranker = None
    if a.reranker:
        from sentence_transformers import CrossEncoder
        import torch
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        reranker = CrossEncoder(a.reranker, max_length=512, device=dev,
                                model_kwargs={"torch_dtype": torch.float16} if dev == "cuda" else {})
        print(f"reranker {a.reranker} na {dev}", flush=True)

    res = {"alpha": {}, "rerank": {}, "speed": {}}
    for name in a.models:
        print(f"→ {name}: vektory …", flush=True)
        enc = OllamaEncoder(name, a.ollama)
        C = enc.encode(docs, batch_size=a.batch)
        S = {s: enc.encode([q_text(r["q"]) for r in rows], batch_size=a.batch) @ C.T for s, rows in sets.items()}
        res["alpha"][name] = {s: {f"{al:g}": rank_metrics(al * S[s] + (1 - al) * L[s], REL[s]) for al in a.alphas}
                              for s in sets}
        for s in sets:
            best = max(a.alphas, key=lambda al: (res["alpha"][name][s][f"{al:g}"]["MRR@10"], res["alpha"][name][s][f"{al:g}"]["R@1"]))
            print(f"   {s}: nejlepší α={best:g} {res['alpha'][name][s][f'{best:g}']}", flush=True)
        if not reranker:
            continue
        res["rerank"][name] = {}
        for s, rows in sets.items():
            H = a.base_alpha * S[s] + (1 - a.base_alpha) * L[s]
            kmax = max(a.rerank_k)
            R, cand, dt = rerank_scores(H, rows, corpus, reranker, kmax, a.rerank_batch)
            res["speed"][f"{name}/{s}"] = {"ms_na_dotaz_k%d" % kmax: round(1000 * dt / len(rows), 1)}
            Hc = np.take_along_axis(H, cand, axis=1)
            out = {}
            for k in a.rerank_k:
                Rk, Hk, ck = R[:, :k], Hc[:, :k], cand[:, :k]
                out[f"k{k}:rerank"] = metrics_from_candidates(Rk, ck, REL[s])
                Rn = np.stack([_minmax(x) for x in Rk]); Hn = np.stack([_minmax(x) for x in Hk])
                for b in a.betas:
                    out[f"k{k}:mix{b:g}"] = metrics_from_candidates(b * Rn + (1 - b) * Hn, ck, REL[s])
            out["bez rerankeru"] = rank_metrics(H, REL[s])
            res["rerank"][name][s] = out
            bk = max(out, key=lambda k: (out[k]["MRR@10"], out[k]["R@1"]))
            print(f"   rerank {s}: bez {out['bez rerankeru']['R@1']:.3f} → nejlépe {bk} R@1 {out[bk]['R@1']:.3f} "
                  f"MRR {out[bk]['MRR@10']:.3f} ({1000 * dt / len(rows):.0f} ms/dotaz, k={kmax})", flush=True)

    if reranker is not None:
        # Orientační rychlost na CPU (server bez GPU): 5 dotazů × 20 kandidátů.
        try:
            from sentence_transformers import CrossEncoder
            cpu = CrossEncoder(a.reranker, max_length=512, device="cpu")
            rows = sets.get("gold", next(iter(sets.values())))[:5]
            pairs = [(r["q"], docs[j]) for r in rows for j in range(20)]
            t0 = time.time(); cpu.predict(pairs, batch_size=20, show_progress_bar=False)
            res["speed"]["cpu_ms_na_dotaz_k20"] = round(1000 * (time.time() - t0) / len(rows), 0)
            print("   CPU:", res["speed"]["cpu_ms_na_dotaz_k20"], "ms/dotaz (k=20)", flush=True)
        except Exception as e:  # noqa: BLE001
            res["speed"]["cpu_chyba"] = str(e)[:200]

    if a.report:
        write_report(a, res, sets)


def write_report(a, res, sets):
    os.makedirs(a.report, exist_ok=True)
    with open(os.path.join(a.report, "rerank_metrics.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    L = ["# Vyhledávání — váha hybridu a reranker", "",
         "Celé paragrafy (server je dělí na kousky ~700 znaků). Rozhoduje zlatá sada `gold` (ruční dotazy); "
         "`test*` jsou dotazy vygenerované qwenem (max. %d na sadu)." % a.test_limit, ""]
    for name, per in res["alpha"].items():
        L += [f"## {name} — váha hybridu α (R@1 / MRR@10)", "", "| Sada | " + " | ".join(f"α={x:g}" for x in a.alphas) + " |",
              "|---|" + "---|" * len(a.alphas)]
        for s in sets:
            L.append(f"| {s} | " + " | ".join(f"{per[s][f'{x:g}']['R@1']:.1%} / {per[s][f'{x:g}']['MRR@10']:.3f}" for x in a.alphas) + " |")
        L.append("")
    for name, per in res["rerank"].items():
        keys = list(next(iter(per.values())).keys())
        L += [f"## {name} — reranker {a.reranker} nad hybridem α={a.base_alpha:g} (R@1 / MRR@10)", "",
              "| Varianta | " + " | ".join(sets) + " |", "|---|" + "---|" * len(sets)]
        for k in ["bez rerankeru"] + [x for x in keys if x != "bez rerankeru"]:
            L.append(f"| {k} | " + " | ".join(f"{per[s][k]['R@1']:.1%} / {per[s][k]['MRR@10']:.3f}" for s in sets if s in per) + " |")
        L.append("")
    if res["speed"]:
        L += ["## Rychlost rerankeru", "", "```", json.dumps(res["speed"], ensure_ascii=False, indent=1), "```", ""]
    with open(os.path.join(a.report, "rerank_report.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
