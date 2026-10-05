#!/bin/bash
# Převod doladěného modelu (sentence-transformers / HF) do GGUF a do Ollamy + kontrola shody.
#   bash export_gguf.sh <model_dir> <out_dir> [ollama_name]
# Výstup: <out_dir>/lexis-bge-m3-ft.gguf, Modelfile, gguf_check.json
set -euo pipefail
MODEL_DIR="$1"; OUT="$2"; NAME="${3:-lexis-bge-m3-ft}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
if [ ! -d /opt/llama.cpp ]; then
  git clone --depth 1 https://github.com/ggml-org/llama.cpp /opt/llama.cpp
fi
PY="${PY:-python3}"
"$PY" -m pip install -q -e /opt/llama.cpp/gguf-py sentencepiece protobuf 2>/dev/null || "$PY" -m pip install -q gguf sentencepiece protobuf
"$PY" /opt/llama.cpp/convert_hf_to_gguf.py "$MODEL_DIR" --outfile "$OUT/$NAME.gguf" --outtype f16
printf 'FROM ./%s.gguf\n' "$NAME" > "$OUT/Modelfile"
( cd "$OUT" && ollama create "$NAME" -f Modelfile )
"$PY" "$HERE/gguf_check.py" --hf "$MODEL_DIR" --ollama "$NAME" --out "$OUT/gguf_check.json"
