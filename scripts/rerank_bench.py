#!/usr/bin/env python3
"""Rychlost rerankeru na TOMTO počítači (Mac M1–M4 přes MPS, NVIDIA přes CUDA, jinak CPU).

Měří ms na jeden dotaz při přeřazení 20 úseků ~700 znaků z báze zákonů (stejné kousky jako server).
Jen veřejné zákony z repozitáře, nic se neodesílá (model se jednou stáhne z Hugging Face).

  python3 -m venv ~/.venvs/lexis-rerank
  ~/.venvs/lexis-rerank/bin/pip install torch einops "sentence-transformers>=3.4,<6" "transformers>=4.44,<5"
  ~/.venvs/lexis-rerank/bin/python scripts/rerank_bench.py
  # jen jeden model:  … rerank_bench.py --models BAAI/bge-reranker-v2-m3
"""
import argparse
import os
import platform
import random
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "training", "embed"))
from common import load_corpus  # noqa: E402
from search_lab import chunk_text  # noqa: E402

MODELS = ["BAAI/bge-reranker-v2-m3", "Alibaba-NLP/gte-multilingual-reranker-base",
          "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"]
QUERIES = ["Soused mi nevrací půjčené peníze, co můžu dělat?", "Jak vysokou kauci může pronajímatel bytu požadovat?",
           "Kdy se promlčí právo na náhradu škody?", "Může soud snížit nepřiměřeně vysokou smluvní pokutu?",
           "Jak se odvolat proti rozsudku a v jaké lhůtě?", "Kdo ručí za dluhy společnosti s ručením omezeným?"]


def main():
    import torch
    from sentence_transformers import CrossEncoder
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=MODELS)
    ap.add_argument("--k", type=int, default=20)
    a = ap.parse_args()
    corpus = load_corpus(os.path.join(ROOT, "backend", "eval", "kb", "zakony.tar.gz"))
    chunks = [c for d in corpus for c in chunk_text(d["text"])]
    random.seed(0)
    devs = (["cuda"] if torch.cuda.is_available() else []) + \
           (["mps"] if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else []) + ["cpu"]
    print(f"{platform.platform()} · {platform.processor() or platform.machine()} · torch {torch.__version__} · zařízení {devs}")
    print(f"{len(QUERIES)} dotazů × {a.k} úseků (~{sum(map(len, chunks)) // len(chunks)} znaků)\n")
    print(f"{'model':48} {'zařízení':8} {'ms/dotaz':>9}")
    for name in a.models:
        for dev in devs:
            try:
                kw = {"trust_remote_code": True}
                if dev in ("cuda", "mps"):
                    kw["model_kwargs"] = {"torch_dtype": torch.float16}
                ce = CrossEncoder(name, max_length=512, device=dev, **kw)
                ce.predict([(QUERIES[0], chunks[0])] * 4, show_progress_bar=False)       # zahřátí
                t0 = time.time()
                for q in QUERIES:
                    ce.predict([(q, c) for c in random.sample(chunks, a.k)], batch_size=a.k, show_progress_bar=False)
                ms = 1000 * (time.time() - t0) / len(QUERIES)
                print(f"{name:48} {dev:8} {ms:9.0f}", flush=True)
                del ce
            except Exception as e:  # noqa: BLE001
                print(f"{name:48} {dev:8}   chyba: {str(e)[:80]}", flush=True)
    print("\nDo ~1000 ms/dotaz je reranker pro uživatele nepostřehnutelný (odpověď agenta trvá ~15–20 s).")


if __name__ == "__main__":
    main()
