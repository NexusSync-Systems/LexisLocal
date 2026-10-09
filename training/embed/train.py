#!/usr/bin/env python3
"""Doladění BAAI/bge-m3 (hustý vektor) na dvojicích dotaz → paragraf.

- Ztráta: CachedMultipleNegativesRankingLoss — ostatní paragrafy v dávce jsou negativní
  příklady; „cached“ dovolí velkou dávku i na GPU s 16–24 GB.
- Těžké negativy: pro každý dotaz paragraf, který původní model řadí vysoko, ale správný
  není (pořadí 3–15). 8. 10. 2026 (po 4. běhu): vynechávají se i sousední paragrafy téhož
  zákona (±3) a texty skoro shodné se správným paragrafem — často jsou také relevantní a
  model se je učil odsouvat (na ručních dotazech pak přehazoval 1. a 2. místo).
- Dotazy k testovacím paragrafům se do tréninku nedostanou (build_pairs.py je odloží).

  python3 train.py --archive …/zakony.tar.gz --pairs out/ --out out/model [--epochs 1]
"""
import argparse
import json
import os
import random
import re
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_corpus, read_jsonl, p_text, q_text  # noqa: E402


def _par_num(d):
    m = re.match(r"(\d+)", str(d.get("par", "")))
    return int(m.group(1)) if m else None


def is_neighbor(a, b, span=3):
    """Sousední paragraf téhož zákona (±span), např. § 1829 a § 1832."""
    na, nb = _par_num(a), _par_num(b)
    return a["law"] == b["law"] and na is not None and nb is not None and abs(na - nb) <= span


def mine_hard_negatives(model, corpus, rows, lo=2, hi=15, batch=16, seed=7, neighbor_span=3, max_pos_sim=0.92):
    rnd = random.Random(seed)
    C = model.encode([p_text(d) for d in corpus], batch_size=batch, normalize_embeddings=True,
                     convert_to_numpy=True, show_progress_bar=False)
    skipped = {"soused": 0, "shodný": 0, "náhodný": 0}
    idx = {d["id"]: i for i, d in enumerate(corpus)}
    Q = model.encode([q_text(r["query"]) for r in rows], batch_size=batch * 4, normalize_embeddings=True,
                     convert_to_numpy=True, show_progress_bar=False)
    out = []
    for start in range(0, len(rows), 2048):
        S = Q[start:start + 2048] @ C.T
        top = np.argsort(-S, axis=1)[:, :hi + 35]
        for k, r in enumerate(rows[start:start + 2048]):
            pos = idx[r["pos"]]
            cands = []
            # Nejdřív pořadí lo..hi; když tam po filtrech nic nezbude, ještě dalších 35 (pořád „těžké“).
            ranked = list(top[k][lo:hi])
            for j in ranked + [None] + list(top[k][hi:]):
                if j is None:
                    if cands:
                        break
                    continue
                if j == pos or corpus[j]["id"] == r["pos"]:
                    continue
                if neighbor_span and is_neighbor(corpus[j], corpus[pos], neighbor_span):
                    skipped["soused"] += 1
                    continue
                if max_pos_sim and float(C[j] @ C[pos]) >= max_pos_sim:
                    skipped["shodný"] += 1
                    continue
                cands.append(j)
            if not cands:
                skipped["náhodný"] += 1
            neg = corpus[rnd.choice(cands)] if cands else corpus[rnd.randrange(len(corpus))]
            out.append({"anchor": q_text(r["query"]), "positive": p_text(corpus[pos]), "negative": p_text(neg)})
    print(f"  těžké negativy: vynecháno sousedních {skipped['soused']}, skoro shodných {skipped['shodný']}; "
          f"náhodný negativ u {skipped['náhodný']} dotazů", flush=True)
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
    ap.add_argument("--neg-neighbor-span", type=int, default=3, help="nebrat za negativ paragraf ±N téhož zákona (0 = vypnout)")
    ap.add_argument("--neg-max-pos-sim", type=float, default=0.92, help="nebrat za negativ text s kosinem ke správnému ≥ X (0 = vypnout)")
    ap.add_argument("--max-train-min", type=float, default=0,
                    help="po N minutách tréninku skončit a model uložit (pojistka před vypnutím instance)")
    a = ap.parse_args()

    import torch
    from datasets import Dataset
    from sentence_transformers import SentenceTransformer, SentenceTransformerTrainer, SentenceTransformerTrainingArguments
    from sentence_transformers.losses import CachedMultipleNegativesRankingLoss
    from sentence_transformers.training_args import BatchSamplers
    from transformers import TrainerCallback

    t0 = time.time()
    corpus = load_corpus(a.archive)
    ids = {d["id"] for d in corpus}
    rows = [r for r in read_jsonl(os.path.join(a.pairs, "pairs_train.jsonl")) if r["pos"] in ids]
    n_kl = sum(1 for r in rows if r.get("styl") == "klient")
    print(f"trénovacích dvojic: {len(rows)} (z toho klientský styl {n_kl})", flush=True)

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
        data = mine_hard_negatives(model, corpus, rows, neighbor_span=a.neg_neighbor_span, max_pos_sim=a.neg_max_pos_sim)
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
    # 6. 10. 2026 (4. běh): trénink na T4 trval přes 2,5 h a hrozilo, že ho vypnutí instance utne
    # dřív, než se model uloží. Proto časový limit: po něm se trénink zastaví a model se uloží.
    class Deadline(TrainerCallback):
        def __init__(self, minutes):
            self.end = t0 + minutes * 60 if minutes else None  # od startu skriptu (vč. těžkých negativů)
            self.stopped_at = None

        def on_step_end(self, args, state, control, **kw):
            if state.global_step % 10 == 0:
                el = (time.time() - t0) / 60
                print(f"  krok {state.global_step}/{state.max_steps} · {el:.1f} min", flush=True)
            if self.end and time.time() >= self.end:
                self.stopped_at = state.global_step
                print(f"  ⏱ limit tréninku — končím po kroku {state.global_step}/{state.max_steps}", flush=True)
                control.should_training_stop = True
            return control

    dl = Deadline(a.max_train_min)
    trainer = SentenceTransformerTrainer(model=model, args=args, train_dataset=ds, loss=loss, callbacks=[dl])
    trainer.train()

    os.makedirs(a.out, exist_ok=True)
    model.save(a.out)
    info = {"base": a.base, "pairs": len(rows), "epochs": a.epochs, "lr": a.lr, "batch": a.batch,
            "hard_negatives": not a.no_hard_neg, "neg_neighbor_span": a.neg_neighbor_span,
            "neg_max_pos_sim": a.neg_max_pos_sim, "pairs_klient": n_kl, "max_len": a.max_len, "precision": "bf16" if bf16 else "fp16",
            "minutes": round((time.time() - t0) / 60, 1), "stopped_early_at_step": dl.stopped_at}
    with open(os.path.join(a.out, "train_info.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=1)
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
