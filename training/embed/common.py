"""Společné funkce pro doladění modelu vyhledávání (bge-m3) na českých zákonech.

Korpus = paragrafy z backend/eval/kb/zakony.tar.gz (jeden soubor = jeden §), stejné
texty, jaké LexisLocal indexuje do báze rešeršníka. Jen veřejné předpisy — žádná
klientská data se do tréninku nedostávají.
"""
import json
import os
import re
import tarfile

LAW_NAMES = {"OZ": "občanský zákoník", "OSR": "občanský soudní řád", "OSŘ": "občanský soudní řád",
             "ZOK": "zákon o obchodních korporacích"}


def load_corpus(archive):
    """→ list dictů {id, law, par, title, path, text} (text = celý soubor jako v bázi)."""
    out = []
    with tarfile.open(archive, "r:gz") as tf:
        for m in tf.getmembers():
            if not m.isfile() or not m.name.endswith(".txt"):
                continue
            raw = tf.extractfile(m).read().decode("utf-8", "replace")
            lines = raw.splitlines()
            head = lines[1] if len(lines) > 1 else ""
            hm = re.match(r"§\s*(\d+[a-z]?)\s*(?:—\s*(.+))?$", head.strip())
            if not hm:
                continue
            law = os.path.basename(os.path.dirname(m.name)) or "?"
            par = hm.group(1)
            title = (hm.group(2) or "").strip()
            body = "\n".join(l for l in lines[3:] if l.strip() and not l.startswith(("Citace:", "Zdroj:")))
            breadcrumb = lines[2].strip("() ") if len(lines) > 2 else ""
            # Nadpis na samostatném řádku („§ 2910 / Porušení zákona“)
            if not title:
                first = body.split("\n", 1)[0].strip()
                if first and not first.startswith("(") and len(first) < 80:
                    title = first
            out.append({"id": os.path.basename(m.name), "law": law, "par": par, "title": title,
                        "path": breadcrumb, "body": body, "text": raw.strip()})
    out.sort(key=lambda d: d["id"])
    return out


def read_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


# bge-m3 se pro dotazy i pasáže používá bez instrukčního prefixu (na rozdíl od bge-*-v1.5).
def q_text(q):
    return q


def p_text(doc):
    return doc["text"]
