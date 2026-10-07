#!/usr/bin/env python3
"""Tréninková data pro model vyhledávání: (dotaz → paragraf) z českých zákonů.

Pro každý paragraf nechá lokální model (Ollama, výchozí qwen2.5:7b — licence Apache 2.0)
napsat několik dotazů, jak by je položil advokát nebo klient. Dotazy nesmí obsahovat číslo
paragrafu ani název zákona — model se má naučit najít paragraf podle OBSAHU.

Výstup (--out):
  pairs_train.jsonl  {query, pos}       … paragrafy pro trénink
  pairs_test.jsonl   {query, pos}       … ~8 % paragrafů odložených jen na hodnocení
  stats.json

Použití:
  python3 build_pairs.py --archive backend/eval/kb/zakony.tar.gz --out out/ \
      [--model qwen2.5:7b] [--per-par 3] [--workers 4] [--limit 200]
"""
import argparse
import concurrent.futures as cf
import json
import os
import random
import re
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_corpus, write_jsonl, read_jsonl, LAW_NAMES  # noqa: E402

PROMPT = """Jsi zkušený český advokát. Níže je jeden paragraf českého zákona.
Napiš {n} různé otázky, na které tento paragraf odpovídá — tak, jak by je položil advokát
při rešerši nebo klient v poradně. Piš česky, přirozeně, každou otázku jinými slovy.

Pravidla:
- NEUVÁDĚJ číslo paragrafu ani název nebo číslo zákona.
- Otázka musí jít zodpovědět právě z tohoto textu.
- Jedna otázka může být krátká (pár slov, jako do vyhledávání), ostatní celou větou.
- Vrať POUZE JSON objekt ve tvaru {{"otazky": ["…", "…", "…"]}}, nic jiného.

Zákon: {law}
Zařazení: {path}
Nadpis: {title}
Text:
{body}
"""


# 6. 10. 2026: s "format": "json" vrací Ollama vždy OBJEKT — pole chtěné v promptu se ztratilo
# (1398 z 1400 paragrafů „prázdný výstup“). Proto JSON schéma s polem „otazky“.
FORMAT = {"type": "object", "properties": {"otazky": {"type": "array", "items": {"type": "string"}}},
          "required": ["otazky"]}


def ollama_generate(host, model, prompt, timeout=300):
    req = urllib.request.Request(
        host.rstrip("/") + "/api/generate",
        data=json.dumps({"model": model, "prompt": prompt, "stream": False, "format": FORMAT,
                         "options": {"temperature": 0.7, "num_ctx": 3072, "num_predict": 256}}).encode(),
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())["response"]


def parse_questions(raw):
    """Dotazy z odpovědi modelu: {"otazky": [...]}, holé pole, objekt s texty, pole objektů…"""
    try:
        v = json.loads(raw)
    except Exception:
        m = re.search(r"[\[{].*[\]}]", raw or "", re.S)
        if not m:
            return []
        try:
            v = json.loads(m.group(0))
        except Exception:
            return []
    out = []

    def walk(x):
        if isinstance(x, str):
            if len(x.strip()) >= 8:
                out.append(x.strip())
        elif isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            for y in x.values():
                walk(y)
    walk(v)
    return out


def clean(qs, doc):
    """Zahodí dotazy s číslem paragrafu/zákona, příliš krátké/dlouhé a duplicity."""
    out, seen = [], set()
    num = doc["par"].lstrip("0")
    for q in qs:
        q = re.sub(r"\s+", " ", q).strip(" -•\"'")
        low = q.lower()
        if len(q) < 8 or len(q) > 300:
            continue
        # 6. 10. 2026: qwen občas sklouzne do čínštiny (~0,5 % dotazů) → pryč.
        if re.search(r"[　-鿿가-힯Ѐ-ӿ]", q):
            continue
        if "§" in q or re.search(r"(?<!\d)" + re.escape(num) + r"(?!\d)", q):
            continue
        if re.search(r"\d+/\d{4}", q) or any(n in low for n in ("občanský zákoník", "občanského zákoníku",
                                                             "soudní řád", "soudního řádu", "obchodních korporac")):
            continue
        if low in seen:
            continue
        seen.add(low)
        out.append(q)
    return out


def usable(doc):
    b = doc["body"]
    return len(b) >= 60 and not re.match(r"^\(?\d*\)?\s*(zrušen|Zrušen)", b)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--archive", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="qwen2.5:7b")
    ap.add_argument("--host", default=os.environ.get("OLLAMA_HOST_URL", "http://127.0.0.1:11434"))
    ap.add_argument("--per-par", type=int, default=3)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--test-frac", type=float, default=0.08)
    ap.add_argument("--limit", type=int, default=0, help="jen prvních N paragrafů (zkouška)")
    ap.add_argument("--max-body", type=int, default=2000, help="delší text se modelu zkrátí")
    ap.add_argument("--deadline-min", type=float, default=0,
                    help="po N minutách generování skončit a pokračovat s tím, co je hotové (další běh naváže)")
    ap.add_argument("--seed", type=int, default=13)
    a = ap.parse_args()

    os.makedirs(a.out, exist_ok=True)
    corpus = [d for d in load_corpus(a.archive) if usable(d)]
    rnd = random.Random(a.seed)
    rnd.shuffle(corpus)
    if a.limit:
        corpus = corpus[:a.limit]
    n_test = max(1, int(len(corpus) * a.test_frac))
    test_ids = {d["id"] for d in corpus[:n_test]}

    # Pokračování po přerušení: už hotové paragrafy přeskočit.
    raw_path = os.path.join(a.out, "questions_raw.jsonl")
    # Paragrafy, u kterých se dotazy nepovedly, se při dalším běhu zkusí znovu.
    done = {r["pos"]: r for r in (read_jsonl(raw_path) if os.path.exists(raw_path) else []) if r.get("questions")}
    todo = [d for d in corpus if d["id"] not in done]
    print(f"paragrafů: {len(corpus)} (test {n_test}), hotovo dříve: {len(done)}, zbývá: {len(todo)}", flush=True)

    t0 = time.time()

    def work(doc):
        body = doc["body"] if len(doc["body"]) <= a.max_body else doc["body"][:a.max_body] + " …"
        prompt = PROMPT.format(n=a.per_par, law=LAW_NAMES.get(doc["law"], doc["law"]), path=doc["path"] or "—",
                               title=doc["title"] or "—", body=body)
        err = "prázdný výstup"
        for attempt in range(3):
            try:
                raw_out = ollama_generate(a.host, a.model, prompt)
                qs = clean(parse_questions(raw_out), doc)
                if qs:
                    return {"pos": doc["id"], "questions": qs[: a.per_par + 1]}
                err = "prázdný výstup: " + str(raw_out)[:160]
            except Exception as e:  # síť / timeout → zkusit znovu
                err = str(e)
                time.sleep(2 + attempt * 3)
        return {"pos": doc["id"], "questions": [], "error": err}

    # Po dávkách, ať jde generování ukončit v termínu (--deadline-min); hotové je průběžně v souboru.
    step = max(1, a.workers * 10)
    i = 0
    with open(raw_path, "a", encoding="utf-8") as raw, cf.ThreadPoolExecutor(a.workers) as ex:
      for start in range(0, len(todo), step):
        if a.deadline_min and (time.time() - t0) / 60 >= a.deadline_min:
            print(f"  ⏱ limit {a.deadline_min:.0f} min — končím generování, hotovo {i}/{len(todo)} (další běh naváže)", flush=True)
            break
        for r in ex.map(work, todo[start:start + step]):
            i += 1
            raw.write(json.dumps(r, ensure_ascii=False) + "\n")
            raw.flush()
            if r.get("questions"):
                done[r["pos"]] = r
            if i % 50 == 0 or i == len(todo):
                el = time.time() - t0
                print(f"  {i}/{len(todo)} paragrafů · {el / 60:.1f} min · ~{el / i * (len(todo) - i) / 60:.0f} min zbývá", flush=True)

    # Doplňkové krátké dotazy z nadpisů („Smluvní pokuta“) — tak advokáti často hledají.
    titles = {d["id"]: d["title"] for d in corpus if d["title"] and len(d["title"]) >= 6}

    train, test, empty = [], [], 0
    for d in corpus:
        r = done.get(d["id"])
        qs = list(r["questions"]) if r else []
        if not qs:
            empty += 1
        if d["id"] in titles and d["id"] not in test_ids:
            qs.append(titles[d["id"]])
        for q in qs:
            (test if d["id"] in test_ids else train).append({"query": q, "pos": d["id"]})
    write_jsonl(os.path.join(a.out, "pairs_train.jsonl"), train)
    write_jsonl(os.path.join(a.out, "pairs_test.jsonl"), test)
    stats = {"paragraphs": len(corpus), "test_paragraphs": n_test, "train_pairs": len(train), "test_pairs": len(test),
             "paragraphs_without_questions": empty, "model": a.model, "per_par": a.per_par,
             "minutes": round((time.time() - t0) / 60, 1)}
    with open(os.path.join(a.out, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=1)
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
