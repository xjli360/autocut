import datetime
import logging
import os
import time
from typing import Any, Dict, List, Union

import numpy as np
import srt

from .whisper_model import AbstractWhisperModel

# Resolve FunASR aliases to the modelscope cache when already downloaded, so
# AutoModel loads from disk and never re-enters the hub download/verify path
# (which ignores manually fetched files and re-downloads on every start).
_MS_CACHE = os.path.expanduser("~/.cache/modelscope/hub/models")
_ALIAS_REPOS = {
    "paraformer-zh": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "fsmn-vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "ct-punc-c": "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
}


def _local_or_alias(name: str) -> str:
    repo = _ALIAS_REPOS.get(name)
    if repo:
        path = os.path.join(_MS_CACHE, repo)
        if os.path.exists(os.path.join(path, "model.pt")):
            return path
    return name


class FunASRModel(AbstractWhisperModel):
    """ASR backend based on Alibaba FunASR Paraformer.

    Compared with whisper it gives better Chinese accuracy, native punctuation
    and millisecond-level sentence timestamps, which is what the studio's
    text-based editing relies on. VAD (fsmn-vad) and punctuation (ct-punc)
    run inside the FunASR pipeline, so the silero VAD pass is skipped.
    """

    def __init__(self, sample_rate=16000):
        super().__init__("funasr", sample_rate)

    def load(
        self,
        device: Union[str, None] = None,
        model: str = "paraformer-zh",
        hotwords: str = "",
    ):
        from funasr import AutoModel

        self.hotwords = hotwords
        tic = time.time()
        # ct-punc-c is the zh-cn punctuation model (~290MB); the default
        # ct-punc (cn-en large) is ~1.1GB for little gain on Chinese content
        self.whisper_model = AutoModel(
            model=_local_or_alias(model),
            vad_model=_local_or_alias("fsmn-vad"),
            punc_model=_local_or_alias("ct-punc-c"),
            device=device or "cpu",
            disable_update=True,
            disable_pbar=True,
            log_level="ERROR",
        )
        logging.info(f"Loaded FunASR {model} in {time.time() - tic:.1f} sec")

    def transcribe(self, audio: np.ndarray) -> List[Dict[str, Any]]:
        """Return sentence segments: [{"start", "end", "text"}] in seconds."""
        results = self.whisper_model.generate(
            input=audio,
            fs=self.sample_rate,
            batch_size_s=300,
            sentence_timestamp=True,
            hotword=self.hotwords,
        )
        sentences = []
        for res in results:
            for s in res.get("sentence_info", []):
                text = s["text"].strip()
                if not text:
                    continue
                sentences.append(
                    {
                        "start": s["start"] / 1000.0,
                        "end": s["end"] / 1000.0,
                        "text": text,
                    }
                )
        sentences.sort(key=lambda s: s["start"])
        return sentences

    def _transcribe(self, *args, **kwargs):
        raise NotImplementedError("FunASR runs VAD internally, no per-segment call")

    def gen_srt(self, transcribe_results: List[Dict[str, Any]]) -> List[srt.Subtitle]:
        return [
            srt.Subtitle(
                index=i,
                start=datetime.timedelta(seconds=s["start"]),
                end=datetime.timedelta(seconds=s["end"]),
                content=s["text"],
            )
            for i, s in enumerate(transcribe_results, start=1)
        ]
