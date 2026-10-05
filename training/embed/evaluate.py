#!/usr/bin/env python3
"""Hodnocení modelu vyhledávání: najde k dotazu správný paragraf?

Metriky (jen hustý/sémantický vektor, bez lexikální složky hybridního RAG v LexisLocalu):
  R@1, R@5, R@10 — podíl dotazů, kde je správný paragraf mezi prvními 1/5/10,
  MRR@10         — průměr 1/pořadí správného paragrafu (0, když není v top 10).

Sady: test  = dotazy k paragrafům, které model při tréninku neviděl,
      gold  = ručně psané dotazy (gold_queries.json), jen k hodnocení.

  python3 evaluate.py --archive …/zakony.tar.gz --pairs out/ --models BAAI/bge-m3 out/model --report out/
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_corpus, read_jsonl, p_text, q_text  # noqa: E402


def rank_metrics(scores, rel_idx, ks=(1, 5, 10)):
    order = np.argsort(-scores, axis=1)[:, :10]
    out = {f"R@{k}": 0.0 for k in ks}
    mrr = 0.0
    for i, rel in enumerate(rel_idx):
        row = list(order[i])
        pos = next((r for r, j in enumerate(row) if j in rel), None)
        for k in ks:
            if pos is not None and pos < k:
                out[f"R@{k}"] += 1
        if pos is not None:
            mrr += 1.0 / (pos + 1)
    n = max(1, len(rel_idx))
    out = {k: round(v / n, 4) for k, v in out.items()}
    out["MRR@10"] = round(mrr / n, 4)
    out["n"] = len(rel_idx)
    return out


def encode(model, texts, batch, is_query):
    return model.encode(texts, batch_size=batch, normalize_embeddings=True, show_progress_bar=False,
                        convert_to_numpy=True)


def evaluate_model(name, corpus, sets, batch=16, max_len=512):
    from sentence_transformers import SentenceTransformer
    m = SentenceTransformer(name)
    m.max_seq_length = max_len
    C = encode(m, [p_text(d) for d in corpus], batch, False)
    idx = {d["id"]: i for i, d in enumerate(corpus)}
    res = {}
    for sname, rows in sets.items():
        rows = [r for r in rows if all(x in idx for x in r["rel"])]
        if not rows:
            continue
        Q = encode(m, [q_text(r["q"]) for r in rows], batch, True)
        res[sname] = rank_metrics(Q @ C.T, [{idx[x] for x in r["rel"]} for r in rows])
    del m
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass
    return res


def load_sets(pairs_dir, gold_path):
    sets = {}
    tp = os.path.join(pairs_dir, "pairs_test.jsonl") if pairs_dir else None
    if tp and os.path.exists(tp):
        sets["test"] = [{"q": r["query"], "rel": [r["pos"]]} for r in read_jsonl(tp)]
    if gold_path and os.path.exists(gold_path):
        sets["gold"] = [{"q": g["q"], "rel": g["rel"]} for g in json.load(open(gold_path, encoding="utf-8"))["queries"]]
    return sets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True)
    ap.add_argument("--pairs", default="")
    ap.add_argument("--gold", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_queries.json"))
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--report", default="")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=512)
    a = ap.parse_args()

    corpus = load_corpus(a.archive)
    sets = load_sets(a.pairs, a.gold)
    results = {}
    for name in a.models:
        print(f"→ hodnotím {name} …", flush=True)
        results[name] = evaluate_model(name, corpus, sets, a.batch, a.max_len)
        print(json.dumps(results[name], ensure_ascii=False), flush=True)

    if a.report:
        os.makedirs(a.report, exist_ok=True)
        with open(os.path.join(a.report, "metrics.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        lines = ["# Model vyhledávání — srovnání", "",
                 f"Korpus: {len(corpus)} paragrafů (OZ, OSŘ, ZOK). Jen sémantické vyhledávání (bez lexikální složky).", ""]
        for sname in sets:
            lines += [f"## Sada `{sname}`", "", "| Model | R@1 | R@5 | R@10 | MRR@10 | dotazů |", "|---|---|---|---|---|---|"]
            for name, r in results.items():
                x = r.get(sname)
                if x:
                    lines.append(f"| {name} | {x['R@1']:.1%} | {x['R@5']:.1%} | {x['R@10']:.1%} | {x['MRR@10']:.3f} | {x['n']} |")
            lines.append("")
        with open(os.path.join(a.report, "report.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("\n".join(lines))


if __name__ == "__main__":
    main()
