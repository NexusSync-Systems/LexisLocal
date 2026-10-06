#!/usr/bin/env python3
"""Doladění BAAI/bge-m3 (hustý vektor) na dvojicích dotaz → paragraf.

- Ztráta: CachedMultipleNegativesRankingLoss — ostatní paragrafy v dávce jsou negativní
  příklady; „cached“ dovolí velkou dávku i na GPU s 16–24 GB.
- Těžké negativy: pro každý dotaz paragraf, který původní model řadí vysoko, ale správný
  není (pořadí 3–15, aby se nebraly téměř stejné sousední paragrafy).
- Dotazy k testovacím paragrafům se do tréninku nedostanou (build_pairs.py je odloží).

  python3 train.py --archive …/zakony.tar.gz --pairs out/ --out out/model [--epochs 1]
"""
import argparse
import json
import os
import random
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_corpus, read_jsonl, p_text, q_text  # noqa: E402


def mine_hard_negatives(model, corpus, rows, lo=2, hi=15, batch=16, seed=7):
    rnd = random.Random(seed)
    C = model.encode([p_text(d) for d in corpus], batch_size=batch, normalize_embeddings=True,
                     convert_to_numpy=True, show_progress_bar=False)
    idx = {d["id"]: i for i, d in enumerate(corpus)}
    Q = model.encode([q_text(r["query"]) for r in rows], batch_size=batch * 4, normalize_embeddings=True,
                     convert_to_numpy=True, show_progress_bar=False)
    out = []
    for start in range(0, len(rows), 2048):
        S = Q[start:start + 2048] @ C.T
        top = np.argsort(-S, axis=1)[:, :hi]
        for k, r in enumerate(rows[start:start + 2048]):
            pos = idx[r["pos"]]
            cands = [j for j in top[k][lo:] if j != pos and corpus[j]["id"] != r["pos"]]
            neg = corpus[rnd.choice(cands)] if cands else corpus[rnd.randrange(len(corpus))]
            out.append({"anchor": q_text(r["query"]), "positive": p_text(corpus[pos]), "negative": p_text(neg)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True)
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="BAAI/bge-m3")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--batch", type=int, default=64, help="velikost dávky pro ztrátu (počet negativů)")
    ap.add_argument("--mini-batch", type=int, default=4, help="kolik se počítá najednou (paměť GPU)")
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--no-hard-neg", action="store_true")
    a = ap.parse_args()

    import torch
    from datasets import Dataset
    from sentence_transformers import SentenceTransformer, SentenceTransformerTrainer, SentenceTransformerTrainingArguments
    from sentence_transformers.losses import CachedMultipleNegativesRankingLoss
    from sentence_transformers.training_args import BatchSamplers

    t0 = time.time()
    corpus = load_corpus(a.archive)
    ids = {d["id"] for d in corpus}
    rows = [r for r in read_jsonl(os.path.join(a.pairs, "pairs_train.jsonl")) if r["pos"] in ids]
    print(f"trénovacích dvojic: {len(rows)}", flush=True)

    model = SentenceTransformer(a.base)
    model.max_seq_length = a.max_len
    # 6. 10. 2026: na T4 (16 GB) došla paměť už v 1. kroku → gradient checkpointing + Adafactor
    # (stavy optimalizátoru ~4× menší než AdamW).
    try:
        model[0].auto_model.gradient_checkpointing_enable()
    except Exception as e:
        print("gradient checkpointing nejde:", e, flush=True)

    if a.no_hard_neg:
        data = [{"anchor": q_text(r["query"]), "positive": p_text(next(d for d in corpus if d["id"] == r["pos"]))} for r in rows]
    else:
        print("těžké negativy (původní model) …", flush=True)
        data = mine_hard_negatives(model, corpus, rows)
    ds = Dataset.from_list(data).shuffle(seed=42)

    bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    args = SentenceTransformerTrainingArguments(
        output_dir=os.path.join(a.out, "_ckpt"),
        num_train_epochs=a.epochs,
        per_device_train_batch_size=a.batch,
        learning_rate=a.lr,
        warmup_ratio=0.1,
        bf16=bf16,
        fp16=torch.cuda.is_available() and not bf16,
        batch_sampler=BatchSamplers.NO_DUPLICATES,
        logging_steps=20,
        optim="adafactor",
        save_strategy="no",
        report_to=[],
        seed=42,
    )
    loss = CachedMultipleNegativesRankingLoss(model, mini_batch_size=a.mini_batch)
    trainer = SentenceTransformerTrainer(model=model, args=args, train_dataset=ds, loss=loss)
    trainer.train()

    os.makedirs(a.out, exist_ok=True)
    model.save(a.out)
    info = {"base": a.base, "pairs": len(rows), "epochs": a.epochs, "lr": a.lr, "batch": a.batch,
            "hard_negatives": not a.no_hard_neg, "max_len": a.max_len, "precision": "bf16" if bf16 else "fp16",
            "minutes": round((time.time() - t0) / 60, 1)}
    with open(os.path.join(a.out, "train_info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
