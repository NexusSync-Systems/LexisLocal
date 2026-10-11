#!/usr/bin/env python3
"""Lokální služba rerankeru pro LexisLocal (lib/reranker.js). Nic neodesílá mimo stroj.

API (stejné jako llama.cpp `llama-server --reranking`):
  POST /v1/rerank   {"query": "...", "documents": ["...", ...], "top_n": N}
                    → {"results": [{"index": i, "relevance_score": s}, ...]}  (seřazeno sestupně)
  GET  /health      → {"status": "ok", "model": ..., "device": ...}

Zařízení: CUDA (NVIDIA) → Apple MPS (M1–M4) → CPU. Na samotném CPU je bge-reranker-v2-m3 pomalý
(~19 s na 20 úseků) — tam reranker raději nezapínat (viz training/embed/README.md).

  pip install sentence-transformers torch
  RERANK_MODEL=BAAI/bge-reranker-v2-m3 python3 scripts/rerank_server.py --port 8081
  # backend/.env: RAG_RERANK=1  RAG_RERANK_URL=http://127.0.0.1:8081
"""
import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_DOCS = 64
MAX_BODY = 2 * 1024 * 1024


def pick_device(pref):
    import torch
    if pref != "auto":
        return pref
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load(model, device):
    import torch
    from sentence_transformers import CrossEncoder
    kw = {"trust_remote_code": True}
    if device in ("cuda", "mps"):
        kw["model_kwargs"] = {"torch_dtype": torch.float16}
    return CrossEncoder(model, max_length=512, device=device, **kw)


def make_handler(ce, model, device, lock):
    class H(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # bez textů dotazů v logu
            pass

        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.rstrip("/") == "/health":
                return self._send(200, {"status": "ok", "model": model, "device": device})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path.rstrip("/") not in ("/v1/rerank", "/rerank"):
                return self._send(404, {"error": "not found"})
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._send(413, {"error": "tělo požadavku chybí nebo je příliš velké"})
            try:
                req = json.loads(self.rfile.read(n).decode("utf-8"))
                q, docs = str(req["query"]), [str(d) for d in req["documents"]]
            except Exception:  # noqa: BLE001
                return self._send(400, {"error": "očekávám {query, documents[]}"})
            if not docs:
                return self._send(200, {"results": []})
            if len(docs) > MAX_DOCS:
                return self._send(400, {"error": f"nejvýš {MAX_DOCS} dokumentů"})
            t0 = time.time()
            with lock:
                scores = ce.predict([(q, d) for d in docs], batch_size=32, show_progress_bar=False)
            res = sorted(({"index": i, "relevance_score": float(s)} for i, s in enumerate(scores)),
                         key=lambda x: -x["relevance_score"])
            top_n = int(req.get("top_n") or len(res))
            self._send(200, {"results": res[:top_n], "model": model, "ms": round(1000 * (time.time() - t0))})
    return H


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3"))
    ap.add_argument("--host", default="127.0.0.1", help="jen lokálně; nevystavovat do sítě")
    ap.add_argument("--port", type=int, default=int(os.environ.get("RERANK_PORT", "8081")))
    ap.add_argument("--device", default=os.environ.get("RERANK_DEVICE", "auto"), choices=["auto", "cuda", "mps", "cpu"])
    a = ap.parse_args()
    dev = pick_device(a.device)
    ce = load(a.model, dev)
    ce.predict([("zahřátí", "zahřátí")], show_progress_bar=False)
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(ce, a.model, dev, threading.Lock()))
    print(f"reranker {a.model} na {dev} — http://{a.host}:{a.port}/v1/rerank", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
