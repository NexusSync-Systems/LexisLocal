#!/usr/bin/env python3
"""Shoda vektorů: model v Ollamě (GGUF) vs. stejný model v sentence-transformers.
Kosinová podobnost by měla být > 0,99 — jinak se při převodu něco ztratilo (pooling, tokenizer)."""
import argparse, json, urllib.request
import numpy as np

TEXTS = ["Promlčecí lhůta trvá tři roky.", "Jak vysokou kauci může pronajímatel požadovat?",
         "Odvolání se podává do patnácti dnů od doručení písemného vyhotovení rozhodnutí.",
         "Minimální výše vkladu je 1 Kč.", "Smí nájemce chovat v bytě psa?"]

def ollama(name, texts, host="http://127.0.0.1:11434"):
    req = urllib.request.Request(host + "/api/embed", data=json.dumps({"model": name, "input": texts}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return np.array(json.loads(r.read())["embeddings"], dtype=np.float32)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--hf"); ap.add_argument("--ollama"); ap.add_argument("--out")
    a = ap.parse_args()
    from sentence_transformers import SentenceTransformer
    H = SentenceTransformer(a.hf).encode(TEXTS, normalize_embeddings=True)
    O = ollama(a.ollama, TEXTS); O = O / np.linalg.norm(O, axis=1, keepdims=True)
    cos = [float(x) for x in (H * O).sum(1)]
    res = {"min_cosine": round(min(cos), 5), "cosines": [round(c, 5) for c in cos], "ok": min(cos) > 0.99}
    json.dump(res, open(a.out, "w"), indent=1); print(json.dumps(res))
    if not res["ok"]:
        raise SystemExit("!! GGUF v Ollamě dává jiné vektory než původní model")

if __name__ == "__main__":
    main()
