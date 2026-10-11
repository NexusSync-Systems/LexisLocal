#!/usr/bin/env python3
"""Laboratoř vyhledávání — 2. měření (11. 10. 2026). Na serveru nic nemění, jen měří.

Navazuje na rerank_eval.py (reranker bge-reranker-v2-m3: zlatá sada R@1 70 → 77 %, ale na CPU ~19 s).
Měří přesně tak, jak hledá server (lib/rag.js): paragrafy rozdělené na kousky ~700 znaků s překryvem
120 (port chunkText), hybrid 0,8 × sémantika + 0,2 × lexikální shoda, z každého paragrafu nejlepší
kousek (dedupeKb). Model vyhledávání = doladěný mix-0.3 v Ollamě (stejné GGUF jako server).

  A) Členění:   celé paragrafy  vs.  kousky jako server  vs.  kousky s hlavičkou (zákon + § + nadpis)
  B) Přepis dotazu chat modelem (qwen2.5:7b): laický dotaz → právní pojmy. Varianty: jen přepis,
     původní + přepis (spojený text), fúze skóre (průměr hybridu obou). + čas na dotaz.
  C) Rerankery (cross-encoder) nad top K paragrafy: přesnost + rychlost GPU / CPU (4 vlákna, fp32 a int8).
  D) Kombinace: nejlepší přepis + nejlepší reranker.

  python3 search_lab.py --archive …/zakony.tar.gz --pairs pairs/ --ollama http://127.0.0.1:11434 --report out/
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_corpus, q_text  # noqa: E402
from evaluate import OllamaEncoder, lexical_matrix, load_sets, rank_metrics  # noqa: E402
from rerank_eval import metrics_from_candidates, _minmax  # noqa: E402

DEFAULT_RERANKERS = [
    "BAAI/bge-reranker-v2-m3",                        # 568M, Apache 2.0 (referenční)
    "Alibaba-NLP/gte-multilingual-reranker-base",     # 306M, Apache 2.0
    "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",     # 118M, Apache 2.0
]

# --- port lib/rag.js chunkText (RAG_CHUNK_MAX_CHARS=700, RAG_CHUNK_OVERLAP_CHARS=120) ---------------
_SENT = re.compile(r'(?<=[.!?])\s+(?=[A-ZÁ-Ža-zá-ž0-9(„"])')


def _split_sentences(p, mx):
    out = []
    for s in _SENT.split(p):
        seg = s.strip()
        if not seg:
            continue
        if len(seg) <= mx:
            out.append(seg)
            continue
        buf = ""
        for w in seg.split():
            if len(w) > mx:
                if buf:
                    out.append(buf)
                    buf = ""
                out.extend(w[i:i + mx] for i in range(0, len(w), mx))
                continue
            if buf and len(buf) + 1 + len(w) > mx:
                out.append(buf)
                buf = w
            else:
                buf = buf + " " + w if buf else w
        if buf:
            out.append(buf)
    return out


def _tail(chunk, ov):
    if ov <= 0:
        return ""
    if len(chunk) <= ov:
        return chunk
    sl = chunk[len(chunk) - ov:]
    sp = sl.find(" ")
    return sl[sp + 1:] if sp >= 0 else sl


def chunk_text(text, mx=700, ov=120):
    paras = [p.strip() for p in re.split(r"\r?\n", text) if p.strip()]
    units = []
    for p in paras:
        units.extend([p] if len(p) <= mx else _split_sentences(p, mx))
    chunks, cur = [], ""
    for u in units:
        if cur and len(cur) + 1 + len(u) > mx:
            chunks.append(cur)
            t = _tail(cur, ov)
            cur = t + " " + u if t else u
        else:
            cur = cur + " " + u if cur else u
    if cur:
        chunks.append(cur)
    return [c.strip() for c in chunks if c.strip()]


def build_units(corpus, mode):
    """mode: par | chunk | chunk_hdr → (texty jednotek, vlastník = index paragrafu, začátky segmentů)."""
    texts, owner = [], []
    for di, d in enumerate(corpus):
        if mode == "par":
            texts.append(d["text"])
            owner.append(di)
            continue
        lines = [l.strip() for l in d["text"].splitlines() if l.strip()]
        hdr = " ".join(lines[:2])
        for ci, c in enumerate(chunk_text(d["text"])):
            texts.append(f"{hdr} — {c}" if mode == "chunk_hdr" and ci > 0 else c)
            owner.append(di)
    owner = np.asarray(owner)
    starts = np.flatnonzero(np.r_[True, owner[1:] != owner[:-1]])
    assert len(starts) == len(corpus), "každý paragraf musí mít aspoň jeden kousek"
    return texts, owner, starts


def encode_cached(enc, texts, cache, batch):
    todo = [t for t in dict.fromkeys(texts) if t not in cache]
    if todo:
        for t, v in zip(todo, enc.encode(todo, batch_size=batch)):
            cache[t] = v
    return np.stack([cache[t] for t in texts])


class Space:
    """Jedno členění korpusu: vektory jednotek + výpočet skóre paragrafů jako server (max přes kousky)."""

    def __init__(self, mode, corpus, enc, cache, batch):
        self.mode = mode
        self.texts, self.owner, self.starts = build_units(corpus, mode)
        self.E = encode_cached(enc, self.texts, cache, batch)
        self.ends = np.r_[self.starts[1:], len(self.texts)]
        print(f"   členění {mode}: {len(self.texts)} jednotek", flush=True)

    def unit_scores(self, Qv, queries, alpha):
        return alpha * (Qv @ self.E.T) + (1 - alpha) * lexical_matrix(queries, self.texts)

    def par_scores(self, U):
        return np.maximum.reduceat(U, self.starts, axis=1)

    def best_unit_text(self, U_row, doc):
        s, e = self.starts[doc], self.ends[doc]
        return self.texts[s + int(np.argmax(U_row[s:e]))]


# --- přepis dotazu ------------------------------------------------------------------------------------
REWRITE_PROMPT = (
    "Jsi asistent české advokátní kanceláře. Přepiš dotaz klienta do stručného dotazu v právní "
    "terminologii českého práva (občanský zákoník, občanský soudní řád, zákon o obchodních korporacích). "
    "Uveď hlavní právní pojmy a instituty, kterých se dotaz týká. Na dotaz neodpovídej, nevymýšlej čísla "
    "paragrafů ani zákonů. Výstup: jeden řádek, nejvýš 25 slov, bez uvozovek.\n\nDotaz: {q}\nPřepis:")


def rewrite(q, url, model):
    body = json.dumps({"model": model, "prompt": REWRITE_PROMPT.format(q=q), "stream": False,
                       "options": {"temperature": 0, "num_predict": 80}}).encode()
    req = urllib.request.Request(url.rstrip("/") + "/api/generate", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        out = json.loads(r.read().decode()).get("response", "")
    line = next((l.strip() for l in out.splitlines() if l.strip()), "")
    line = re.sub(r"§\s*\d+\w*", "", line).strip(" \"'„“")   # pro jistotu bez čísel paragrafů
    return line or q


# --- rerankery ----------------------------------------------------------------------------------------
def load_reranker(name, device, fp16=True):
    import torch
    from sentence_transformers import CrossEncoder
    kw = {"trust_remote_code": True}
    if device == "cuda" and fp16:
        kw["model_kwargs"] = {"torch_dtype": torch.float16}
    return CrossEncoder(name, max_length=512, device=device, **kw)


def cpu_speed(name, pairs, threads):
    """ms na dotaz (k = len(pairs)/5) na CPU — fp32 a dynamická int8 kvantizace lineárních vrstev."""
    import torch
    torch.set_num_threads(threads)
    out = {}
    try:
        ce = load_reranker(name, "cpu")
        ce.predict(pairs[:2], batch_size=2, show_progress_bar=False)       # zahřátí
        t0 = time.time(); ce.predict(pairs, batch_size=20, show_progress_bar=False)
        out["cpu_fp32_ms"] = round(1000 * (time.time() - t0) / 5)
        try:
            ce.model = torch.quantization.quantize_dynamic(ce.model, {torch.nn.Linear}, dtype=torch.qint8)
            ce.predict(pairs[:2], batch_size=2, show_progress_bar=False)
            t0 = time.time(); ce.predict(pairs, batch_size=20, show_progress_bar=False)
            out["cpu_int8_ms"] = round(1000 * (time.time() - t0) / 5)
        except Exception as e:  # noqa: BLE001
            out["cpu_int8_chyba"] = str(e)[:160]
        del ce
    except Exception as e:  # noqa: BLE001
        out["cpu_chyba"] = str(e)[:160]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True)
    ap.add_argument("--pairs", default="")
    ap.add_argument("--gold", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "gold_queries.json"))
    ap.add_argument("--ollama", required=True)
    ap.add_argument("--model", default="lexis-bge-m3-ft", help="model vyhledávání v Ollamě")
    ap.add_argument("--chat-model", default="qwen2.5:7b", help="model pro přepis dotazu")
    ap.add_argument("--alpha", type=float, default=0.8)
    ap.add_argument("--rerankers", nargs="*", default=DEFAULT_RERANKERS)
    ap.add_argument("--k", type=int, default=20)
    ap.add_argument("--beta", type=float, default=0.85)
    ap.add_argument("--test-limit", type=int, default=300)
    ap.add_argument("--cpu-threads", type=int, default=4)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--skip-rewrite", action="store_true")
    ap.add_argument("--report", default="")
    a = ap.parse_args()
    t_start = time.time()

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
    REL = {s: [{idx[x] for x in r["rel"]} for r in rows] for s, rows in sets.items()}
    print("sady:", {k: len(v) for k, v in sets.items()}, flush=True)
    res = {"meta": {"model": a.model, "alpha": a.alpha, "k": a.k, "beta": a.beta, "sady": {k: len(v) for k, v in sets.items()}},
           "cleneni": {}, "prepis": {}, "rerank": {}, "kombinace": {}}

    enc = OllamaEncoder(a.model, a.ollama)
    cache = {}
    QV = {s: enc.encode([q_text(r["q"]) for r in rows], batch_size=a.batch) for s, rows in sets.items()}
    QS = {s: [r["q"] for r in rows] for s, rows in sets.items()}

    # A) členění
    spaces, U = {}, {}
    for mode in ("par", "chunk", "chunk_hdr"):
        sp = Space(mode, corpus, enc, cache, a.batch)
        spaces[mode] = sp
        res["cleneni"][mode] = {}
        for s in sets:
            U[(mode, s)] = sp.unit_scores(QV[s], QS[s], a.alpha)
            res["cleneni"][mode][s] = rank_metrics(sp.par_scores(U[(mode, s)]), REL[s])
        print(f"   A {mode}: gold {res['cleneni'][mode].get('gold')}", flush=True)
    best_mode = max(("chunk", "chunk_hdr"), key=lambda m: (res["cleneni"][m]["gold"]["MRR@10"], res["cleneni"][m]["gold"]["R@1"]))
    res["meta"]["cleneni_pro_dalsi_kroky"] = best_mode
    sp = spaces[best_mode]
    PS = {s: sp.par_scores(U[(best_mode, s)]) for s in sets}

    # B) přepis dotazu
    PS_fused = None
    if not a.skip_rewrite:
        rw, times = {}, []
        for s, rows in sets.items():
            for r in rows:
                if r["q"] not in rw:
                    t0 = time.time()
                    try:
                        rw[r["q"]] = rewrite(r["q"], a.ollama, a.chat_model)
                    except Exception as e:  # noqa: BLE001
                        print("!! přepis selhal:", str(e)[:120], flush=True)
                        rw[r["q"]] = r["q"]
                    times.append(time.time() - t0)
        res["prepis"]["_cas_ms_median"] = round(1000 * float(np.median(times))) if times else None
        res["prepis"]["_ukazky"] = [{"q": r["q"], "prepis": rw[r["q"]]} for r in sets.get("gold", [])[:12]]
        PS_fused = {}
        for s, rows in sets.items():
            q_rw = [rw[r["q"]] for r in rows]
            q_cat = [f"{r['q']} ({rw[r['q']]})" for r in rows]
            P_rw = sp.par_scores(sp.unit_scores(enc.encode(q_rw, batch_size=a.batch), q_rw, a.alpha))
            P_cat = sp.par_scores(sp.unit_scores(enc.encode(q_cat, batch_size=a.batch), q_cat, a.alpha))
            PS_fused[s] = (PS[s] + P_rw) / 2
            res["prepis"][s] = {"původní": rank_metrics(PS[s], REL[s]), "jen přepis": rank_metrics(P_rw, REL[s]),
                                "původní + přepis (text)": rank_metrics(P_cat, REL[s]),
                                "fúze skóre": rank_metrics(PS_fused[s], REL[s])}
        print("   B přepis gold:", {k: v["R@1"] for k, v in res["prepis"].get("gold", {}).items()}, flush=True)
        os.makedirs(a.report or ".", exist_ok=True)
        with open(os.path.join(a.report or ".", "rewrites.json"), "w", encoding="utf-8") as f:
            json.dump(rw, f, ensure_ascii=False, indent=0)

    # C) rerankery (+ D kombinace u každého)
    import torch
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    speed_pairs = None
    for name in a.rerankers:
        print(f"→ reranker {name}", flush=True)
        out = {}
        try:
            ce = load_reranker(name, dev)
        except Exception as e:  # noqa: BLE001
            res["rerank"][name] = {"chyba": str(e)[:200]}
            print("!! nelze načíst:", str(e)[:200], flush=True)
            continue
        gpu_t, gpu_n = 0.0, 0
        for s, rows in sets.items():
            for label, P in (("", PS[s]),) + ((("+přepis", PS_fused[s]),) if PS_fused else ()):
                cand = np.argsort(-P, axis=1)[:, :a.k]
                Ub = U[(best_mode, s)]
                pairs = [(r["q"], sp.best_unit_text(Ub[i], int(j))) for i, r in enumerate(rows) for j in cand[i]]
                if speed_pairs is None:
                    speed_pairs = pairs[:5 * a.k]
                t0 = time.time()
                R = np.asarray(ce.predict(pairs, batch_size=32, show_progress_bar=False), dtype=np.float32).reshape(len(rows), a.k)
                gpu_t += time.time() - t0; gpu_n += len(rows)
                Pc = np.take_along_axis(P, cand, axis=1)
                Rn = np.stack([_minmax(x) for x in R]); Pn = np.stack([_minmax(x) for x in Pc])
                m_only = metrics_from_candidates(R, cand, REL[s])
                m_mix = metrics_from_candidates(a.beta * Rn + (1 - a.beta) * Pn, cand, REL[s])
                if label:
                    res["kombinace"].setdefault(name, {})[s] = {"bez": rank_metrics(P, REL[s]), "rerank": m_only, f"mix{a.beta:g}": m_mix}
                else:
                    out[s] = {"bez": rank_metrics(P, REL[s]), "rerank": m_only, f"mix{a.beta:g}": m_mix}
        out["_gpu_ms_na_dotaz"] = round(1000 * gpu_t / max(1, gpu_n))
        del ce
        torch.cuda.empty_cache() if dev == "cuda" else None
        out.update(cpu_speed(name, speed_pairs, a.cpu_threads))
        res["rerank"][name] = out
        g = out.get("gold", {})
        print(f"   gold: bez {g.get('bez', {}).get('R@1')} rerank {g.get('rerank', {}).get('R@1')} "
              f"mix {g.get(f'mix{a.beta:g}', {}).get('R@1')} | {out.get('_gpu_ms_na_dotaz')} ms GPU, "
              f"{out.get('cpu_fp32_ms')} ms CPU fp32, {out.get('cpu_int8_ms')} ms CPU int8", flush=True)

    res["meta"]["minut"] = round((time.time() - t_start) / 60, 1)
    if a.report:
        write_report(a, res, sets)


def _f(x):
    return f"{x['R@1']:.1%} / {x['MRR@10']:.3f}" if x else "–"


def write_report(a, res, sets):
    os.makedirs(a.report, exist_ok=True)
    with open(os.path.join(a.report, "search_lab.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    S = list(sets)
    L = ["# Laboratoř vyhledávání — 2. měření", "",
         f"Model `{res['meta']['model']}`, hybrid α={a.alpha}, z každého paragrafu nejlepší kousek (jako server). "
         f"Buňky: R@1 / MRR@10. Sady: {res['meta']['sady']}. Trvalo {res['meta']['minut']} min.", "",
         "## A) Členění textu", "", "| Členění | " + " | ".join(S) + " |", "|---|" + "---|" * len(S)]
    for m, per in res["cleneni"].items():
        L.append(f"| {m} | " + " | ".join(_f(per.get(s)) for s in S) + " |")
    L += ["", f"Další kroky počítány nad členěním **{res['meta']['cleneni_pro_dalsi_kroky']}**.", ""]
    if res["prepis"]:
        L += ["## B) Přepis dotazu chat modelem", "", f"Medián času přepisu: {res['prepis'].get('_cas_ms_median')} ms.", "",
              "| Varianta | " + " | ".join(S) + " |", "|---|" + "---|" * len(S)]
        variants = list(next(v for k, v in res["prepis"].items() if not k.startswith("_")).keys())
        for v in variants:
            L.append(f"| {v} | " + " | ".join(_f(res["prepis"].get(s, {}).get(v)) for s in S) + " |")
        L += ["", "Ukázky přepisu (zlatá sada):", ""] + [f"- {x['q']} → *{x['prepis']}*" for x in res["prepis"].get("_ukazky", [])] + [""]
    L += [f"## C) Rerankery (top {a.k}, mix β={a.beta:g})", "", "| Reranker | Varianta | " + " | ".join(S) + " |",
          "|---|---|" + "---|" * len(S)]
    for name, out in res["rerank"].items():
        if "chyba" in out:
            L.append(f"| {name} | chyba: {out['chyba'][:80]} |" + " |" * len(S))
            continue
        for v in ("bez", "rerank", f"mix{a.beta:g}"):
            L.append(f"| {name} | {v} | " + " | ".join(_f(out.get(s, {}).get(v)) for s in S) + " |")
    L += ["", "| Reranker | GPU ms/dotaz | CPU fp32 ms/dotaz | CPU int8 ms/dotaz |", "|---|---|---|---|"]
    for name, out in res["rerank"].items():
        L.append(f"| {name} | {out.get('_gpu_ms_na_dotaz', '–')} | {out.get('cpu_fp32_ms', out.get('cpu_chyba', '–'))} | "
                 f"{out.get('cpu_int8_ms', out.get('cpu_int8_chyba', '–'))} |")
    L += ["", f"CPU = {a.cpu_threads} vlákna (g4dn.xlarge), {a.k} kousků serveru na dotaz.", ""]
    if res["kombinace"]:
        L += ["## D) Přepis (fúze skóre) + reranker", "", "| Reranker | Varianta | " + " | ".join(S) + " |", "|---|---|" + "---|" * len(S)]
        for name, per in res["kombinace"].items():
            for v in ("bez", "rerank", f"mix{a.beta:g}"):
                L.append(f"| {name} | {v} | " + " | ".join(_f(per.get(s, {}).get(v)) for s in S) + " |")
        L.append("")
    with open(os.path.join(a.report, "search_lab.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    print("\n".join(L))


if __name__ == "__main__":
    main()
