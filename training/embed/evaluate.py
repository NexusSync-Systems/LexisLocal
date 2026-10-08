#!/usr/bin/env python3
"""Hodnocení modelu vyhledávání: najde k dotazu správný paragraf?

Metriky (jen hustý/sémantický vektor, bez lexikální složky hybridního RAG v LexisLocalu):
  R@1, R@5, R@10 — podíl dotazů, kde je správný paragraf mezi prvními 1/5/10,
  MRR@10         — průměr 1/pořadí správného paragrafu (0, když není v top 10).

Sady: test  = dotazy k paragrafům, které model při tréninku neviděl,
      gold  = ručně psané dotazy (gold_queries.json), jen k hodnocení;
              gold_klient / gold_advokat = totéž rozdělené podle stylu dotazu.

Ke každé sadě se počítá i „hybrid“ = 0,8 × sémantika + 0,2 × lexikální shoda — stejně jako
LexisLocal na serveru (RAG_HYBRID=1, RAG_HYBRID_ALPHA=0.8, lexicalScore z backend/lib/rag.js).
Pozn.: hodnotí se celé paragrafy; server je dělí na kousky po ~700 znacích.

  python3 evaluate.py --archive …/zakony.tar.gz --pairs out/ --models BAAI/bge-m3 out/model --report out/
"""
import argparse
import json
import os
import sys

import re
import unicodedata
from collections import Counter

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


# --- Lexikální skóre jako v backend/lib/rag.js (lexicalScore): kosinus četností slov bez diakritiky ---
_STOP = set("a i o u v k s z na do od po za se si je to ve ke ze pro nad pod pri ci by byl byla bylo "
            "jako tak ale nebo aby jsou jsem the of and or in on at".split())


def _lex_tokens(text):
    t = unicodedata.normalize("NFD", str(text or ""))
    t = "".join(ch for ch in t if not unicodedata.combining(ch)).lower()
    return [w for w in re.split(r"[^a-z0-9]+", t) if len(w) >= 2 and w not in _STOP]


def lexical_matrix(queries, docs):
    """→ matice [len(queries), len(docs)] s lexikálním skóre 0..1."""
    inv, norms = {}, np.zeros(len(docs))
    for j, d in enumerate(docs):
        tf = Counter(_lex_tokens(d))
        norms[j] = np.sqrt(sum(v * v for v in tf.values()))
        for w, v in tf.items():
            inv.setdefault(w, []).append((j, v))
    out = np.zeros((len(queries), len(docs)), dtype=np.float32)
    for i, q in enumerate(queries):
        tf = Counter(_lex_tokens(q))
        nq = np.sqrt(sum(v * v for v in tf.values()))
        if not nq:
            continue
        for w, v in tf.items():
            for j, dv in inv.get(w, ()):
                out[i, j] += v * dv
        nz = norms > 0
        out[i, nz] /= (nq * norms[nz])
    return out


def ranks_of(scores, rel_idx):
    """Pořadí (1 = první) správného paragrafu pro každý dotaz; None = mimo top 10."""
    order = np.argsort(-scores, axis=1)[:, :10]
    out = []
    for i, rel in enumerate(rel_idx):
        row = list(order[i])
        out.append(next((r + 1 for r, j in enumerate(row) if j in rel), None))
    return out


def encode(model, texts, batch, is_query):
    if isinstance(model, OllamaEncoder):
        return model.encode(texts, batch_size=batch)
    return model.encode(texts, batch_size=batch, normalize_embeddings=True, show_progress_bar=False,
                        convert_to_numpy=True)


class OllamaEncoder:
    """Vektory z Ollamy (/api/embed) — stejná cesta jako na serveru LexisLocal (GGUF)."""

    def __init__(self, model, url):
        self.model, self.url = model, url.rstrip("/")

    def encode(self, texts, batch_size=16, **_):
        import urllib.request
        out = []
        for i in range(0, len(texts), batch_size):
            body = json.dumps({"model": self.model, "input": texts[i:i + batch_size], "truncate": True}).encode()
            req = urllib.request.Request(self.url + "/api/embed", data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=600) as r:
                out.extend(json.loads(r.read().decode())["embeddings"])
            if i and i % (batch_size * 50) == 0:
                print(f"    {self.model}: {i}/{len(texts)}", flush=True)
        v = np.asarray(out, dtype=np.float32)
        return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


def evaluate_model(name, corpus, sets, batch=16, max_len=512, alpha=0.8, lex_cache=None, ollama_url=""):
    if ollama_url:
        m = OllamaEncoder(name, ollama_url)
    else:
        from sentence_transformers import SentenceTransformer
        m = SentenceTransformer(name)
        m.max_seq_length = max_len
    C = encode(m, [p_text(d) for d in corpus], batch, False)
    idx = {d["id"]: i for i, d in enumerate(corpus)}
    res, detail = {}, {}
    lex_cache = {} if lex_cache is None else lex_cache
    for sname, rows in sets.items():
        rows = [r for r in rows if all(x in idx for x in r["rel"])]
        if not rows:
            continue
        rel = [{idx[x] for x in r["rel"]} for r in rows]
        Q = encode(m, [q_text(r["q"]) for r in rows], batch, True)
        S = Q @ C.T
        if sname not in lex_cache:
            lex_cache[sname] = lexical_matrix([r["q"] for r in rows], [p_text(d) for d in corpus])
        H = alpha * S + (1 - alpha) * lex_cache[sname]
        res[sname] = rank_metrics(S, rel)
        res[sname + "+hybrid"] = rank_metrics(H, rel)
        if sname == "gold":
            rd, rh = ranks_of(S, rel), ranks_of(H, rel)
            detail = [{"q": r["q"], "styl": r.get("styl"), "rel": r["rel"][0], "rank": a, "rank_hybrid": b}
                      for r, a, b in zip(rows, rd, rh)]
    res["_gold_detail"] = detail
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
        gold = [{"q": g["q"], "rel": g["rel"], "styl": g.get("styl", "")}
                for g in json.load(open(gold_path, encoding="utf-8"))["queries"]]
        sets["gold"] = gold
        for st in sorted({g["styl"] for g in gold if g["styl"]}):
            sets["gold_" + st] = [g for g in gold if g["styl"] == st]
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
    ap.add_argument("--alpha", type=float, default=0.8, help="podíl sémantiky v hybridu (jako RAG_HYBRID_ALPHA)")
    ap.add_argument("--ollama", default="", help="URL Ollamy (např. http://127.0.0.1:11434) → --models jsou názvy modelů v Ollamě")
    a = ap.parse_args()

    corpus = load_corpus(a.archive)
    sets = load_sets(a.pairs, a.gold)
    results, lex_cache = {}, {}
    for name in a.models:
        print(f"→ hodnotím {name} …", flush=True)
        results[name] = evaluate_model(name, corpus, sets, a.batch, a.max_len, a.alpha, lex_cache, a.ollama)
        print(json.dumps({k: v for k, v in results[name].items() if not k.startswith("_")}, ensure_ascii=False), flush=True)
    # Samotná lexikální shoda (bez modelu) — pro představu, kolik přidává sémantika.
    idx = {d["id"]: i for i, d in enumerate(corpus)}
    lex_only = {}
    for sname, rows in sets.items():
        rows = [r for r in rows if all(x in idx for x in r["rel"])]
        if rows and sname in lex_cache:
            lex_only[sname] = rank_metrics(lex_cache[sname], [{idx[x] for x in r["rel"]} for r in rows])
    results["(jen lexikální)"] = lex_only

    if a.report:
        os.makedirs(a.report, exist_ok=True)
        with open(os.path.join(a.report, "metrics.json"), "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
        lines = ["# Model vyhledávání — srovnání", "",
                 f"Korpus: {len(corpus)} paragrafů (OZ, OSŘ, ZOK). Jen sémantické vyhledávání (bez lexikální složky).", ""]
        for sname in sets:
            lines += [f"## Sada `{sname}`", "", "| Model | Způsob | R@1 | R@5 | R@10 | MRR@10 | dotazů |",
                      "|---|---|---|---|---|---|---|"]
            for name, r in results.items():
                for key, how in ((sname, "sémantika" if name != "(jen lexikální)" else "lexikální"),
                                 (sname + "+hybrid", f"hybrid α={a.alpha}")):
                    x = r.get(key)
                    if x:
                        lines.append(f"| {name} | {how} | {x['R@1']:.1%} | {x['R@5']:.1%} | {x['R@10']:.1%} | {x['MRR@10']:.3f} | {x['n']} |")
            lines.append("")
        # Dotazy ze zlaté sady, kde se modely nejvíc liší (hybrid) — pro ruční rozbor.
        names = [n for n in a.models if results[n].get("_gold_detail")]
        if len(names) >= 2:
            d0, d1 = results[names[0]]["_gold_detail"], results[names[1]]["_gold_detail"]
            rk = lambda v: v if v is not None else 11
            diff = sorted(zip(d0, d1), key=lambda p: -abs(rk(p[0]["rank_hybrid"]) - rk(p[1]["rank_hybrid"])))
            lines += ["## Zlatá sada — největší rozdíly (hybrid, pořadí správného §; – = mimo top 10)", "",
                      f"| Dotaz | Styl | § | {names[0]} | {names[1]} |", "|---|---|---|---|---|"]
            for x, y in diff[:25]:
                if rk(x["rank_hybrid"]) == rk(y["rank_hybrid"]):
                    break
                lines.append(f"| {x['q']} | {x['styl']} | {x['rel'].replace('.txt', '')} | {x['rank_hybrid'] or '–'} | {y['rank_hybrid'] or '–'} |")
            lines.append("")
        with open(os.path.join(a.report, "report.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("\n".join(lines))


if __name__ == "__main__":
    main()
