"""
Run a Hugging Face Whisper model on this machine, behind the same API the app
already speaks.

    pip install torch transformers fastapi uvicorn python-multipart soundfile
    python scripts/stt-server.py --model kingabzpro/whisper-large-v3-turbo-urdu

Then point the app at it, in .env:

    STT_BASE_URL="http://127.0.0.1:8123/v1"
    STT_MODEL="kingabzpro/whisper-large-v3-turbo-urdu"
    STT_API_KEY=""

Why this exists: Groq serves only its own models, so a fine-tuned Urdu model
from Hugging Face cannot be used through it. Running it here is the free way to
find out whether such a model is actually better on your voice - which is a
question no benchmark answers, because published word-error rates are measured
on read speech from Common Voice, not on spontaneous Urdu-English order taking.

It deliberately mimics the OpenAI transcription endpoint, so the app needs no
new code path: one base URL and it is talking to a different engine.

This is for TRYING models on your own machine. It is not a deployment: the
laptop has to be running, so the hosted site cannot use it.
"""

from __future__ import annotations

import argparse
import io
import time

import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

parser = argparse.ArgumentParser()
parser.add_argument("--model", default="kingabzpro/whisper-large-v3-turbo-urdu")
parser.add_argument("--port", type=int, default=8123)
parser.add_argument("--device", default="auto", help="auto | cuda | cpu")
args = parser.parse_args()

if args.device == "auto":
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
else:
    device = args.device

# float16 on a GPU halves the memory and roughly doubles the speed; whisper
# large-v3-turbo is about 1.6 GB that way, which fits a 4 GB card.
dtype = torch.float16 if device.startswith("cuda") else torch.float32

print(f"\nLoading {args.model} on {device} ({dtype})...")
print("The first run downloads the weights - a few GB - and then caches them.\n")

model = AutoModelForSpeechSeq2Seq.from_pretrained(
    args.model, torch_dtype=dtype, low_cpu_mem_usage=True
).to(device)
processor = AutoProcessor.from_pretrained(args.model)

asr = pipeline(
    "automatic-speech-recognition",
    model=model,
    tokenizer=processor.tokenizer,
    feature_extractor=processor.feature_extractor,
    torch_dtype=dtype,
    device=device,
)

app = FastAPI()


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "model": args.model, "device": device}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default=""),
    language: str = Form(default=""),
    prompt: str = Form(default=""),
    temperature: str = Form(default="0"),
    response_format: str = Form(default="json"),
) -> JSONResponse:
    """The OpenAI shape: multipart file in, {"text": ...} out."""
    del model, temperature, response_format  # accepted and ignored

    audio = await file.read()
    started = time.time()

    generate_kwargs: dict[str, object] = {"task": "transcribe"}
    # A model fine-tuned on one language usually pins it in its own generation
    # config; passing a different one then fights the model rather than helping.
    if language:
        generate_kwargs["language"] = language

    try:
        result = asr(
            io.BytesIO(audio).getvalue(),
            generate_kwargs=generate_kwargs,
            # Anything past 30 seconds needs chunking; commands are far shorter,
            # but a stray long recording should transcribe rather than fail.
            chunk_length_s=30,
        )
        text = (result.get("text") or "").strip()
    except Exception as error:  # noqa: BLE001 - reported to the caller instead
        print(f"  transcription failed: {error}")
        return JSONResponse(
            status_code=400, content={"error": {"message": str(error)[:300]}}
        )

    took = time.time() - started
    print(f'  {took:5.2f}s  "{text}"')
    return JSONResponse(content={"text": text})


if __name__ == "__main__":
    import uvicorn

    print(f"Listening on http://127.0.0.1:{args.port}")
    print(f'Set STT_BASE_URL="http://127.0.0.1:{args.port}/v1" in .env\n')
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
