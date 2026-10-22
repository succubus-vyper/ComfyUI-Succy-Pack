import asyncio
import io
import json
import math
import os
import random
import re
import threading
import wave
import weakref
from collections import OrderedDict
from collections.abc import Mapping

import folder_paths
import numpy as np
import torch
from PIL import Image


from _succy_common import ANY, parse_bool, parse_float, parse_int, to_container   # the shared drawer (loaded once by __init__.py)

_PREVIEW_FILES = OrderedDict()   # node key -> the temp files it currently shows (the next run deletes the ones it no longer needs)
_PLAYER = OrderedDict()          # node key -> (weak ref to the source video/audio, its player file): same source = no re-save
_FILES_MAX = 256                 # node keys remembered; the oldest goes (and takes its files along). Every closet has a limit.
_MAX_DECODE_BYTES = 4 << 30      # decoding a video window into float frames: past ~4 GB we refuse and say so (trim shorter)
_AUDIO_PEAKS = 600               # bars of the waveform drawn under an audio clip
# The ==== PreviewAny ==== dump in ComfyUI's console: OFF unless you ask for it (SUCCY_PREVIEW_LOG=1 before starting ComfyUI).
# The pane already shows all of it; a console that moans on every run is not a turn-on (D-202).
_LOG = os.environ.get("SUCCY_PREVIEW_LOG", "").strip().lower() not in ("", "0", "false", "no", "off")


class _SkipPreview(Exception):
    """preview is Off: no picture is written."""

_UI_CONTAINER_TYPES = ("JSON", "DICT", "LIST", "ARRAY")
_UI_LIST_TYPES = ("LIST", "ARRAY")
_UI_DICT_TYPES = ("JSON", "DICT")
_OUTPUT_TYPES = ["STRING", "INT", "FLOAT", "BOOLEAN",
                 "LIST", "DICT", "ARRAY", "JSON", "COMBO",
                 "IMAGE", "MASK"]


# ------------------------------------------------------------------ #
#  Parser helpers (module-level, no state)                           #
# ------------------------------------------------------------------ #
def _unwrap_scalar(value):
    """Tensor/array/list with a single element -> the single element."""
    if isinstance(value, torch.Tensor) and value.numel() == 1:
        return value.item()
    if isinstance(value, np.ndarray) and value.size == 1:
        return value.item()
    if isinstance(value, (list, tuple)) and len(value) == 1:
        return _unwrap_scalar(value[0])
    return value


def _to_text(value) -> str:
    """Readable text: dict/list as JSON (UTF-8, never crashes on tensors/objects)."""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, indent=2, ensure_ascii=False, default=str)
    return str(value)


def _parse_int(value) -> int:
    return parse_int(_unwrap_scalar(value), tag="PreviewAny")


def _parse_float(value) -> float:
    return parse_float(_unwrap_scalar(value), tag="PreviewAny")


# ------------------------------------------------------------------ #
#  Media helpers (VIDEO / AUDIO): pure maths first, then the files   #
# ------------------------------------------------------------------ #
def media_kind(value) -> str:
    """'audio' for ComfyUI's AUDIO dict, 'video' for a VIDEO object (VideoInput duck type), '' otherwise."""
    if isinstance(value, dict) and isinstance(value.get("waveform"), torch.Tensor) and "sample_rate" in value:
        return "audio"           # a Mapping that only looks like one (VHS's lazy audio) is turned into a dict by as_audio first
    if callable(getattr(value, "get_components", None)) and callable(getattr(value, "save_to", None)):
        return "video"
    return ""


def trim_window(duration, fps, start, end):
    """The kept window in seconds -> (start, end, trimmed). end <= 0 or past the clip = up to the end; the window is at
    least one frame (or 1 ms without fps) and never leaves the clip. The browser does the same sums (timeline_element)."""
    duration = max(0.0, float(duration or 0.0))
    step = (1.0 / fps) if fps and fps > 0 else 0.001
    s = min(max(0.0, float(start or 0.0)), duration)
    e = float(end or 0.0)
    e = duration if e <= 0 or e > duration else e
    if e - s < step:
        s = max(0.0, min(s, duration - step))
        e = min(duration, s + step)
    trimmed = s > 1e-6 or e < duration - 1e-6
    return s, e, trimmed


def frame_range(start, end, fps, count):
    """Seconds -> frame indexes [f0, f1) (f1 excluded): f0 = round(start * fps), f1 = round(end * fps), at least one frame."""
    count = max(1, int(count))
    f0 = min(max(0, int(round(start * fps))), count - 1)
    f1 = min(max(f0 + 1, int(round(end * fps))), count)
    return f0, f1


def frame_at(t, fps, count):
    """The frame on screen at time t (the one that started last), inside the clip. Half a millisecond of slack: the widget
    keeps 3 decimals, so frame 5 at 24 fps is stored as 0.208 (not 0.20833) and must still read as frame 5."""
    return min(max(0, int(math.floor((float(t or 0.0) + 0.0005) * fps + 1e-6))), max(0, int(count) - 1))


def frame_times(fps, start, end, current, frames=(None, None, None)):
    """The frame rings (D-239): a frame number from a wire beats the seconds of its row. Start = f / fps, End = (f + 1) / fps
    (the frame given is the last one kept), Current = f / fps (frame_at reads it back as f). No fps (audio) = the seconds stay."""
    sf, ef, cf = frames
    if not fps or fps <= 0:
        return start, end, current
    if sf is not None:
        start = max(0, int(sf)) / fps
    if ef is not None:
        end = (max(0, int(ef)) + 1) / fps
    if cf is not None:
        current = max(0, int(cf)) / fps
    return start, end, current


def slice_audio(audio, start, end):
    """AUDIO dict cut to [start, end) seconds (same sample rate); None stays None."""
    if not audio:
        return None
    sr = int(audio["sample_rate"])
    wf = audio["waveform"]
    a0 = max(0, int(round(start * sr)))
    a1 = max(a0 + 1, int(round(end * sr)))
    return {"waveform": wf[..., a0:a1], "sample_rate": sr}


def gain_value(gain):
    """The output volume as a number >= 0 (junk = 1, untouched)."""
    try:
        return max(0.0, float(gain))
    except (TypeError, ValueError):
        return 1.0


def gain_audio(audio, gain):
    """AUDIO louder / softer (gain 1 = untouched, the same object back). Files clip it to -1..1 when written."""
    g = gain_value(gain)
    if not audio or abs(g - 1.0) < 1e-6:
        return audio
    return {"waveform": audio["waveform"] * g, "sample_rate": audio["sample_rate"]}


def silent_audio(seconds, sr=44100):
    """Stand-in for a video with no sound track: silence as long as the window, so the next node still gets an AUDIO."""
    return {"waveform": torch.zeros(1, 1, max(1, int(round(seconds * sr)))), "sample_rate": sr}


def audio_peaks(waveform, bins=_AUDIO_PEAKS):
    """Loudest sample per bar (first item of the batch, all channels), 0..1 with 3 decimals: what the timeline draws."""
    x = waveform[0].abs().float()
    x = x.amax(0) if x.dim() == 2 else x.reshape(-1)
    n_s = int(x.shape[0])
    if n_s == 0:
        return []
    n = min(int(bins), n_s)
    k = -(-n_s // n)
    x = torch.nn.functional.pad(x, (0, k * n - n_s)).reshape(n, k).amax(1)
    top = float(x.max()) or 1.0
    return [round(float(v) / top, 3) for v in x]


def wired_outputs(prompt, unique_id):
    """Output slots of this node that some node downstream reads. None = can't tell (then everything gets computed)."""
    if not isinstance(prompt, dict) or unique_id is None or str(unique_id) not in prompt:
        return None
    uid, out = str(unique_id), set()
    for n in prompt.values():
        for v in ((n or {}).get("inputs") or {}).values():
            if isinstance(v, list) and len(v) == 2 and str(v[0]) == uid:
                try:
                    out.add(int(v[1]))
                except (TypeError, ValueError):
                    pass
    return out


def _video_classes():
    """(VideoFromComponents, VideoComponents) from whichever comfy_api this ComfyUI has, or (None, None)."""
    for mod_in, mod_ut in (("comfy_api.latest._input_impl", "comfy_api.latest._util"), ("comfy_api.input_impl", "comfy_api.util")):
        try:
            a = __import__(mod_in, fromlist=["VideoFromComponents"])
            b = __import__(mod_ut, fromlist=["VideoComponents"])
            return a.VideoFromComponents, b.VideoComponents
        except Exception:
            continue
    return None, None


def _make_video(images, audio, frame_rate):
    vfc, vc = _video_classes()
    if vfc is None:
        raise RuntimeError("Succy Preview: this ComfyUI has no VideoFromComponents (comfy_api) - update ComfyUI to cut videos")
    return vfc(vc(images=images, audio=audio, frame_rate=frame_rate))


class _VideoInfo:
    """What we know about a VIDEO, asking the cheap questions first (fps, duration, size) and decoding only when forced."""

    def __init__(self, video):
        self.video = video
        self._comps = None
        self.fps = self.duration = 0.0
        self.frames = self.width = self.height = 0
        self.has_audio = None
        try:
            self.fps = float(video.get_frame_rate())
        except Exception:
            pass
        try:
            self.duration = float(video.get_duration())
        except Exception:
            pass
        try:
            self.frames = int(video.get_frame_count())
        except Exception:
            pass
        try:
            self.width, self.height = (int(x) for x in video.get_dimensions())
        except Exception:
            pass
        if not (self.fps > 0 and self.frames > 0 and self.width > 0):      # an old ComfyUI: only the components know
            c = self.components()
            self.fps = float(c.frame_rate) if c.frame_rate else 24.0
            self.frames = int(c.images.shape[0])
            self.height, self.width = int(c.images.shape[1]), int(c.images.shape[2])
        if not self.duration > 0:
            self.duration = self.frames / self.fps if self.fps else 0.0
        if self._comps is not None:
            self.has_audio = self._comps.audio is not None
        else:
            self.has_audio = _probe_audio(video)

    def components(self):
        if self._comps is None:
            self._comps = self.video.get_components()
        return self._comps

    def check_decode(self, n_frames):
        need = int(n_frames) * max(1, self.width) * max(1, self.height) * 3 * 4
        if need > _MAX_DECODE_BYTES:
            raise ValueError(f"Succy Preview: decoding {n_frames} frames of {self.width}x{self.height} needs ~{need / (1 << 30):.1f} GB "
                             f"(limit {_MAX_DECODE_BYTES >> 30} GB). Make the selection shorter.")

    def window(self, f0, f1):
        """The video cut to frames [f0, f1): lazy (as_trimmed, nothing decoded) when ComfyUI can, otherwise sliced tensors."""
        if f0 == 0 and f1 >= self.frames:
            return self.video
        fn = getattr(self.video, "as_trimmed", None)
        if callable(fn) and self._comps is None:
            # half a frame of margin on both sides: the decoder keeps start <= pts < end, so frame f0 is in and f1 is out
            s, d = max(0.0, (f0 - 0.5) / self.fps), (f1 - f0) / self.fps
            try:
                cut = fn(start_time=s, duration=d, strict_duration=False)
                if cut is not None:
                    return cut
            except Exception:
                pass
        self.check_decode(self.frames)
        c = self.components()
        return _make_video(c.images[f0:f1], slice_audio(c.audio, f0 / self.fps, f1 / self.fps), c.frame_rate)

    def frame(self, fc):
        """Frame fc as an IMAGE [1, H, W, C]: only that frame is decoded when ComfyUI can trim."""
        if self._comps is None and self.frames > 1:
            cut = self.window(fc, fc + 1)
            if cut is not self.video:
                try:
                    img = cut.get_components().images
                    if img is not None and img.shape[0] >= 1:
                        return img[:1]
                except Exception:
                    pass
        self.check_decode(self.frames)
        return self.components().images[fc:fc + 1]


def _probe_audio(video):
    """Does the file carry a sound track? Asked to the container (no decoding). None = can't tell."""
    try:
        import av
        src = video.get_stream_source()
        with av.open(src, mode="r") as c:
            return len(c.streams.audio) > 0
    except Exception:
        return None


def _node_key(unique_id):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(unique_id)) if unique_id is not None else "x"


def _keep_files(node_key, files):
    """This node now shows `files`: the ones it showed before and no longer needs are deleted. Capped at _FILES_MAX nodes."""
    temp_dir = folder_paths.get_temp_directory()
    old = _PREVIEW_FILES.pop(node_key, [])
    _PREVIEW_FILES[node_key] = list(files)
    drop = [f for f in old if f not in files]
    while len(_PREVIEW_FILES) > _FILES_MAX:
        k, gone = _PREVIEW_FILES.popitem(last=False)
        _PLAYER.pop(k, None)
        drop += gone
    for f in drop:
        try:
            os.remove(os.path.join(temp_dir, f))
        except OSError:
            pass


def _temp_name(node_key, tag, ext):
    return f"succy_preview_{node_key}_{tag}_{random.randint(0, 99999999)}.{ext}"


def _save_video(video, path):
    """VIDEO -> mp4 the browser can play. Tries the newest save_to signature first, then older ones."""
    try:
        from comfy_api.latest import Types
        return video.save_to(path, format=Types.VideoContainer.MP4, codec=Types.VideoCodec.AUTO)
    except ImportError:
        pass
    try:
        from comfy_api.util import VideoContainer, VideoCodec
        return video.save_to(path, format=VideoContainer.MP4, codec=VideoCodec.AUTO)
    except ImportError:
        return video.save_to(path)


def write_wav(path, audio):
    """AUDIO (first item of the batch, up to 2 channels) -> 16-bit PCM WAV: no codec needed, every browser plays it."""
    wf = audio["waveform"][0][:2].detach().float().cpu().clamp(-1.0, 1.0)
    data = (wf * 32767.0).round().to(torch.int16).t().contiguous().numpy().tobytes()
    with wave.open(path, "wb") as w:
        w.setnchannels(int(wf.shape[0]))
        w.setsampwidth(2)
        w.setframerate(int(audio["sample_rate"]))
        w.writeframes(data)


def _player_file(node_key, source, tag, ext, writer, sig=None):
    """The file the player shows for `source`: re-used while the very same object comes back with the same `sig` (a trim change
    re-runs the node with the same upstream output), written again otherwise (new frames, another fps, another sound)."""
    temp_dir = folder_paths.get_temp_directory()
    hit = _PLAYER.get(node_key)
    if hit:
        ref, name, old_sig = hit
        try:
            same = ref() is source and old_sig == sig
        except Exception:
            same = False
        if same and os.path.isfile(os.path.join(temp_dir, name)):
            return name
    name = _temp_name(node_key, tag, ext)
    writer(os.path.join(temp_dir, name))
    try:
        _PLAYER[node_key] = (weakref.ref(source), name, sig)
    except TypeError:                       # not weak-referenceable (a plain dict): remember nothing, write every time
        _PLAYER.pop(node_key, None)
    return name


def _saved(name):
    return {"filename": name, "subfolder": "", "type": "temp"}


# ---- formats (D-198): Convert To for clips = the container / file format ----
# Video: what ComfyUI's LoadVideo opens AND we can write back. "video.auto" = as it came (the frontend swaps it for the real
# format after the first run). Audio: an AUDIO is raw samples, so the format is the download file's (the output stays samples).
VIDEO_FORMATS = ["video.auto", "video.mp4", "video.webm", "video.mkv", "video.mov", "video.avi", "video.gif"]
AUDIO_FORMATS = ["audio.wav", "audio.mp3", "audio.flac", "audio.ogg", "audio.m4a"]
# container -> (av format, video codec, pixel format, audio codec or None)
_VENC = {"mp4": ("mp4", "libx264", "yuv420p", "aac"), "mkv": ("matroska", "libx264", "yuv420p", "aac"),
         "webm": ("webm", "libvpx-vp9", "yuv420p", "libopus"), "mov": ("mov", "libx264", "yuv420p", "aac"),
         "avi": ("avi", "mpeg4", "yuv420p", "pcm_s16le"), "gif": ("gif", "gif", "rgb8", None)}
# audio file -> (av format, codec, sample rates the codec takes or None)
_AENC = {"mp3": ("mp3", "libmp3lame"), "flac": ("flac", "flac"), "ogg": ("ogg", "libopus"), "m4a": ("ipod", "aac")}
# sample rates each codec takes (first = the one we resample to); missing = any
_RATES = {"libopus": (48000, 24000, 16000, 12000, 8000),
          "aac": (48000, 44100, 96000, 88200, 64000, 32000, 24000, 22050, 16000, 12000, 11025, 8000),
          "libmp3lame": (48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000)}


def _fit_rate(audio, codec):
    rates = _RATES.get(codec)
    return audio if not rates or int(audio["sample_rate"]) in rates else _resample(audio, rates[0])


def fmt_ext(value, default):
    """'video.mp4' -> 'mp4'; anything else (old 'VIDEO', 'auto') -> default."""
    v = str(value or "")
    ext = v.split(".", 1)[1].lower() if "." in v else ""
    return ext if ext and ext != "auto" else default


def video_format_of(video):
    """The container a VIDEO came in: the file's extension first, then the demuxer's name. 'mp4' when nobody can tell."""
    try:
        src = video.get_stream_source()
        if isinstance(src, str):
            ext = os.path.splitext(src)[1].lower().lstrip(".")
            if ext in _VENC:
                return ext
            if ext == "m4v":
                return "mp4"
    except Exception:
        pass
    try:
        name = str(video.get_container_format() or "").lower()
    except Exception:
        name = ""
    for key, ext in (("gif", "gif"), ("avi", "avi"), ("webm", "webm"), ("matroska", "mkv"), ("mov", "mp4"), ("mp4", "mp4")):
        if key in name:
            return ext
    return "mp4"


def _video_from_file(path):
    for mod in ("comfy_api.latest._input_impl", "comfy_api.input_impl"):
        try:
            return __import__(mod, fromlist=["VideoFromFile"]).VideoFromFile(path)
        except Exception:
            continue
    raise RuntimeError("Succy Preview: this ComfyUI has no VideoFromFile (comfy_api) - update ComfyUI to convert videos")


def encode_video(images, audio, fps, path, ext):
    """Frames [N, H, W, C] (+ AUDIO) -> a file in container `ext`, with PyAV (what ComfyUI itself uses)."""
    import av
    from fractions import Fraction
    fmt, vcodec, pix, acodec = _VENC[ext]
    n, h, w = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
    rate = Fraction(fps).limit_denominator(1001) if fps else Fraction(24)
    with av.open(path, mode="w", format=fmt) as out:
        vs = out.add_stream(vcodec, rate=rate)
        vs.width, vs.height = (w // 2) * 2 if vcodec != "gif" else w, (h // 2) * 2 if vcodec != "gif" else h
        vs.pix_fmt = pix
        aus = None
        if audio is not None and acodec:
            audio = _fit_rate(audio, acodec)
            ch = min(2, int(audio["waveform"].shape[1]))
            aus = out.add_stream(acodec, rate=int(audio["sample_rate"]), layout="stereo" if ch == 2 else "mono")
        for i in range(n):
            arr = (images[i, : vs.height, : vs.width, :3].clamp(0, 1) * 255).round().to(torch.uint8).cpu().numpy()
            for pkt in vs.encode(av.VideoFrame.from_ndarray(arr, format="rgb24")):
                out.mux(pkt)
        for pkt in vs.encode():
            out.mux(pkt)
        if aus is not None:
            _mux_audio(out, aus, audio)


def _resample(audio, sr):
    wf = audio["waveform"]
    n = max(1, int(round(wf.shape[-1] * sr / int(audio["sample_rate"]))))
    return {"waveform": torch.nn.functional.interpolate(wf.float(), size=n, mode="linear", align_corners=False), "sample_rate": sr}


def _mux_audio(out, stream, audio):
    import av
    wf = audio["waveform"][0][:2].detach().float().cpu().clamp(-1, 1).contiguous()
    frame = av.AudioFrame.from_ndarray(wf.numpy(), format="fltp", layout="stereo" if wf.shape[0] == 2 else "mono")
    frame.sample_rate = int(audio["sample_rate"])
    for pkt in stream.encode(frame):
        out.mux(pkt)
    for pkt in stream.encode():
        out.mux(pkt)


def _save_as(video, path, ext, comps, fps, keep_audio=True):
    """VIDEO -> file in container `ext`: ComfyUI's own save_to for mp4 / mkv / webm (stream copy when it can), our PyAV
    encoder for the rest or when the sound must go (split)."""
    if ext in ("mp4", "mkv", "webm") and keep_audio and callable(getattr(video, "save_to", None)):
        try:
            from comfy_api.latest import Types
            return video.save_to(path, format=Types.VideoContainer(ext), codec=Types.VideoCodec.AUTO)
        except Exception:
            pass
    c = comps()
    encode_video(c.images, c.audio if keep_audio and ext != "gif" else None, fps, path, ext)


def write_audio(path, audio, ext):
    """AUDIO -> file: WAV by hand (no codec), the rest with PyAV."""
    if ext == "wav":
        return write_wav(path, audio)
    import av
    fmt, codec = _AENC[ext]
    audio = _fit_rate(audio, codec)
    ch = min(2, int(audio["waveform"].shape[1]))
    with av.open(path, mode="w", format=fmt) as out:
        st = out.add_stream(codec, rate=int(audio["sample_rate"]), layout="stereo" if ch == 2 else "mono")
        _mux_audio(out, st, audio)



# ------------------------------------------------------------------ #
#  VHS (Video Helper Suite) compatibility (D-203)                    #
#  VHS never sends a VIDEO: its loaders send an IMAGE batch, a lazy  #
#  AUDIO and a video_info dict on separate sockets, its Combine a    #
#  (save_output, [paths]) tuple. We read what we need without asking #
#  for an extra wire: the loader's settings are in the prompt.       #
# ------------------------------------------------------------------ #
VHS_LOADERS = ("VHS_LoadVideo", "VHS_LoadVideoPath", "VHS_LoadVideoFFmpeg", "VHS_LoadVideoFFmpegPath")
_VIDEO_EXTS = (".mp4", ".webm", ".mkv", ".mov", ".avi", ".gif", ".m4v")


def as_audio(value):
    """A real AUDIO dict, or None. VHS's audio is a LazyAudioMap: a Mapping (not a dict) that runs ffmpeg the first time it is
    read and raises when the file has no sound. We read it once, here, and hand the rest of the node a plain dict."""
    if isinstance(value, dict):
        return value if isinstance(value.get("waveform"), torch.Tensor) and "sample_rate" in value else None
    if isinstance(value, Mapping):
        try:
            wf, sr = value["waveform"], value["sample_rate"]
        except Exception:
            return None
        return {"waveform": wf, "sample_rate": sr} if isinstance(wf, torch.Tensor) else None
    return None


def vhs_combine_file(value):
    """VHS_FILENAMES (Video Combine's output: (save_output, [paths])) -> the finished video's path (the last one), or ''."""
    if not (isinstance(value, (tuple, list)) and len(value) == 2 and isinstance(value[0], bool) and isinstance(value[1], (list, tuple))):
        return ""
    for f in reversed(value[1]):
        if isinstance(f, str) and f.lower().endswith(_VIDEO_EXTS) and os.path.isfile(f):
            return f
    return ""


def _literal(v):
    """A prompt input that is a value (not a [node, slot] link)."""
    return None if isinstance(v, list) else v


def vhs_loader(prompt, unique_id):
    """The VHS loader whose IMAGE (slot 0) is plugged into our `source`, as {class_type, inputs}; None if it isn't one."""
    try:
        link = prompt[str(unique_id)]["inputs"]["source"]
        if not (isinstance(link, list) and len(link) == 2) or int(link[1]) != 0:
            return None
        node = prompt[str(link[0])]
    except Exception:
        return None
    if not isinstance(node, dict) or node.get("class_type") not in VHS_LOADERS:
        return None
    return {"class_type": node["class_type"], "inputs": dict(node.get("inputs") or {})}


def _vhs_path(loader):
    raw = _literal(loader["inputs"].get("video"))
    if not isinstance(raw, str) or not raw.strip():
        return ""
    raw = raw.strip().strip('"').strip("'")
    if loader["class_type"].endswith("Path"):
        return raw if os.path.isfile(raw) else ""
    try:
        path = folder_paths.get_annotated_filepath(raw)
    except Exception:
        return ""
    return path if path and os.path.isfile(path) else ""


def _file_fps(path):
    import av
    with av.open(path, mode="r") as c:
        st = c.streams.video[0]
        r = st.average_rate or st.guessed_rate or st.base_rate
        return float(r) if r else 0.0


def vhs_timing(loader, n_frames, file_fps=None):
    """(fps of the frames as loaded, where they start in the file in s). The same sums VHS does: the base rate is force_rate,
    else the file's own; skip_first_frames counts at the base rate (FFmpeg loaders take start_time); every nth stretches it.
    fps 0 = can't tell (a setting arrives on a wire, the file is gone): then the frames are shown as plain pictures."""
    inp = loader["inputs"]
    if inp.get("meta_batch") is not None or inp.get("vae") is not None:
        return 0.0, 0.0              # Batch Manager = the frames come in chunks (where each starts is VHS's secret); VAE = latents
    try:
        force = float(_literal(inp.get("force_rate")) or 0)
        nth = max(1, int(_literal(inp.get("select_every_nth")) or 1))
    except (TypeError, ValueError):
        return 0.0, 0.0
    if any(isinstance(inp.get(k), list) for k in ("force_rate", "select_every_nth", "skip_first_frames", "start_time")):
        return 0.0, 0.0
    base = force if force > 0 else float(file_fps or 0)
    if not base > 0:
        return 0.0, 0.0
    if "start_time" in inp:
        start = float(_literal(inp.get("start_time")) or 0)
    else:
        start = int(_literal(inp.get("skip_first_frames")) or 0) / base
    return base / nth, max(0.0, start)


def file_audio(path, start, seconds):
    """The sound of `path` from `start` for `seconds`, as an AUDIO dict (fltp, up to 2 channels), or None when the file has no
    sound track. Only the audio stream is decoded: the frames are already in memory, no need to undress them twice."""
    import av
    with av.open(path, mode="r") as c:
        if not c.streams.audio:
            return None
        st = c.streams.audio[0]
        sr = int(st.rate or st.codec_context.sample_rate or 44100)
        layout = "stereo" if (st.codec_context.channels or 1) >= 2 else "mono"
        rs = av.AudioResampler(format="fltp", layout=layout, rate=sr)
        if start > 1.0:
            c.seek(int((start - 1.0) / st.time_base), stream=st)          # a second early, cut to the sample below
        end, chunks, first = start + seconds, [], None
        for fr in c.decode(st):
            t = float(fr.pts * fr.time_base) if fr.pts is not None else None
            if t is not None and t >= end:
                break
            for out in rs.resample(fr):
                if first is None:
                    first = t if t is not None else 0.0
                chunks.append(torch.from_numpy(out.to_ndarray().copy()))
        if not chunks:
            return None
    wf = torch.cat(chunks, dim=-1).float()
    a0 = max(0, int(round((start - (first or 0.0)) * sr)))
    a1 = max(a0 + 1, a0 + int(round(seconds * sr)))
    return {"waveform": wf[:, a0:a1].unsqueeze(0).contiguous(), "sample_rate": sr}


# ------------------------------------------------------------------ #
#  Clip or pictures? (D-205)                                         #
#  We read what ARRIVES, never the whole graph: a VIDEO is a clip, an #
#  IMAGE batch is one when it moves like one. fps: the video's own,  #
#  a VHS loader's, the wire, the field; nobody knows = 24.           #
# ------------------------------------------------------------------ #
CLIP_MODES = ["auto", "clip", "images"]
DEFAULT_FPS = 24.0
_THUMB_SIDE = 256            # longest side of a gallery thumbnail (the big view asks for 1600, the download for the full frame)
_BIG_SIDE = 1600
_KEEP_MAX = 32               # nodes whose last gallery / clip the routes remember (weak refs: ComfyUI's cache owns the tensors)
_GALLERY = OrderedDict()     # node key -> (weak ref to the batch shown, token of that Run)
_CLIPS = OrderedDict()       # node key -> what Apply fps needs to re-time the player without a Run (D-205c)
_RETIMED = OrderedDict()     # node key -> (weak ref to the ORIGINAL video, its re-timing signature, the player file at that fps)
_LAST = OrderedDict()        # node key -> the last Run's inputs (source by weak ref): As clip switches live from these (D-205d)


def _remember(store, key, value):
    store.pop(key, None)
    store[key] = value
    while len(store) > _KEEP_MAX:
        store.popitem(last=False)


def looks_like_video(images):
    """auto: does this IMAGE batch move like a clip? At least 6 frames, and neighbours that look alike: either barely different
    (< 4% per pixel) or at most half as different as frames half a batch apart. A batch of seed variants is all equally
    different, so it stays pictures. Measured on a ~32 px copy: costs nothing, even on 1080p."""
    try:
        n = int(images.shape[0])
        if images.dim() != 4 or n < 6:
            return False
        step = max(1, max(int(images.shape[1]), int(images.shape[2])) // 32)
        x = images[:, ::step, ::step, :3].float()
        near = float((x[1:] - x[:-1]).abs().mean())
        far = float((x[n // 2:] - x[:n - n // 2]).abs().mean())
        return near < 0.04 or near < 0.5 * far
    except Exception:
        return False


def pick_fps(fps_override, fps_auto, clip_fps, found, found_from):
    """The clip's fps and where it came from: a wire (EXT) wins, then the field when you typed it, then what the input itself
    says (the video, a VHS loader), then the default."""
    try:
        v = float(_unwrap_scalar(fps_override)) if fps_override is not None else 0.0
    except (TypeError, ValueError):
        v = 0.0
    if v > 0:
        return min(v, 1000.0), "wire"
    try:
        f = float(clip_fps or 0)
    except (TypeError, ValueError):
        f = 0.0
    if not fps_auto and f > 0:
        return min(f, 1000.0), "manual"
    if found and found > 0:
        return float(found), found_from
    return DEFAULT_FPS, "default"


def _to_pil(frame):
    """One frame [H, W, C] or a mask [H, W] -> PIL (alpha kept, 1 channel = grey, more than 4 = the first 3)."""
    arr = np.clip(255.0 * frame.detach().float().cpu().numpy(), 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        return Image.fromarray(arr, mode="L")
    if arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)
    elif arr.shape[-1] > 4:
        arr = arr[..., :3]
    return Image.fromarray(arr, mode="RGBA" if arr.shape[-1] == 4 else "RGB")


def _ref(value):
    """A weak ref when the value takes one (tensors, VIDEO objects: ComfyUI's cache owns them), else a plain holder."""
    try:
        return weakref.ref(value)
    except TypeError:
        return lambda v=value: v


class _VideoFrames:
    """A VIDEO's frames one at a time, for a gallery that never decodes the whole clip (D-205d). Thumbnails are kept as the
    decoder walks forward; a frame behind it (or a bigger one) is found again with a seek. Clips made of tensors are just indexed."""

    def __init__(self, video, total, fps):
        # tensors in memory: a weak ref (ComfyUI's cache owns them); a file-backed video is light, and may be ours alone (VHS Combine)
        self.ref = _ref(video) if type(video).__name__ == "VideoFromComponents" else (lambda v=video: v)
        self.total, self.fps = int(total), float(fps) or DEFAULT_FPS
        self.lock = threading.Lock()
        self.thumbs = {}                  # index -> PIL thumbnail (longest side _THUMB_SIDE)
        self.box = None                   # (container, frame iterator, next index) of the walk going on
        self.images = None                # the frames as tensors, when the clip is made of them (or PyAV can't open it)

    def _open(self, video):
        import av
        src = video.get_stream_source()
        if hasattr(src, "seek"):
            src.seek(0)
        return av.open(src, mode="r")

    def _index(self, fr, st, t0):
        t = float((fr.pts - t0) * st.time_base) if fr.pts is not None else 0.0
        return int(round(t * self.fps))

    def get(self, i, side):
        """Frame i as PIL, its longest side <= side (0 = full size)."""
        with self.lock:
            video = self.ref()
            if video is None:
                return None
            if self.images is None and type(video).__name__ == "VideoFromComponents":
                self.images = video.get_components().images                     # already in memory: nothing to decode
            if self.images is None and not callable(getattr(video, "get_stream_source", None)):
                vi = _VideoInfo(video)
                vi.check_decode(vi.frames)
                self.images = vi.components().images
            if self.images is not None:
                return _to_pil(self.images[i]) if i < int(self.images.shape[0]) else None
            if side and 0 < side <= _THUMB_SIDE and i in self.thumbs:
                return self.thumbs[i]
            box = self.box
            if box is None or box[2] > i or (i - box[2]) * 1.0 > 4 * self.fps:   # behind the walk, or far ahead: seek there
                if box is not None:
                    box[0].close()
                c = self._open(video)
                st = c.streams.video[0]
                t0 = st.start_time or 0
                if i > 0:
                    c.seek(int(t0 + (i / self.fps) / st.time_base), stream=st, backward=True, any_frame=False)
                box = self.box = [c, c.decode(st), -1, st, t0]
            c, it, _, st, t0 = box
            for fr in it:
                k = self._index(fr, st, t0)
                box[2] = k + 1
                if 0 <= k < i and k not in self.thumbs:          # passed on the way: its thumbnail is kept
                    im = fr.to_image(); im.thumbnail((_THUMB_SIDE, _THUMB_SIDE)); self.thumbs[k] = im
                if k >= i:
                    im = fr.to_image()
                    th = im.copy(); th.thumbnail((_THUMB_SIDE, _THUMB_SIDE)); self.thumbs[k] = th
                    return im
            c.close()
            self.box = None
            return None

    def close(self):
        if self.box is not None:
            try:
                self.box[0].close()
            except Exception:
                pass
            self.box = None


def gallery_frame(key, token, index, side=_THUMB_SIDE):
    """One frame of the gallery a node showed last, as PNG bytes: `side` = longest side (0 = full size, for the download).
    None when the Run is old news (another token) or ComfyUI let the batch go: the browser says "expired"."""
    hit = _GALLERY.get(str(key))
    if not hit or hit[1] != str(token):
        return None
    i = int(index)
    if isinstance(hit[0], _VideoFrames):            # a VIDEO as pictures: decoded frame by frame, never all at once
        vf = hit[0]
        if not 0 <= i < vf.total:
            return None
        try:
            im = vf.get(i, side)
        except Exception as ex:
            print(f"[PreviewAny] gallery frame {i}: {ex}")
            im = None
        if im is None:
            return None
    else:
        shown = hit[0]()
        if shown is None:
            return None
        if not 0 <= i < int(shown.shape[0]):
            return None
        im = _to_pil(shown[i])
    if side:
        im = im.copy()
        im.thumbnail((int(side), int(side)))
    buf = io.BytesIO()
    im.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def vhs_clip(prompt, unique_id):
    """Frames straight out of a VHS loader (D-203): (fps, start in the file, file path), or None. Only the DIRECT parent is read."""
    loader = vhs_loader(prompt, unique_id)
    if not loader:
        return None
    path = _vhs_path(loader)
    try:
        ffps = _file_fps(path) if path else 0.0
    except Exception:
        ffps = 0.0
    fps, start0 = vhs_timing(loader, 0, ffps)
    return (fps, start0, path, loader["class_type"]) if fps > 0 else None


# ------------------------------------------------------------------ #
#  Node                                                              #
# ------------------------------------------------------------------ #
class Succy_Preview_Anything_Convert:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preview": ("BOOLEAN", {
                    "default": True,
                    "label_on": "On",
                    "label_off": "Off",
                }),
                "source": (ANY, {"tooltip": "Attach anything here."}),
                # D-233: Convert To is a BRIDGE between nodes: VIDEO / IMAGE / AUDIO for a clip, IMAGE / MASK / VIDEO for pictures.
                # The old file formats (VIDEO_FORMATS / AUDIO_FORMATS) stay valid so saved prompts still run: video.X = VIDEO in X.
                "output_type": (_OUTPUT_TYPES + ["VIDEO", "AUDIO"] + VIDEO_FORMATS + AUDIO_FORMATS, {"default": "STRING"}),
                # only meaningful with output_type MASK: flips the mask (1 - m). The frontend shows it as the INVERT button.
                "invert_mask": ("BOOLEAN", {"default": False}),
                # VIDEO / AUDIO only (the frontend's timeline writes them): the kept window in seconds (end 0 = up to the end)
                # and the frame that goes out of `frame`. Split audio = the video goes out silent and its sound has its own output.
                "trim_start": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1e7, "step": 0.001}),
                "trim_end": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1e7, "step": 0.001}),
                "current_time": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1e7, "step": 0.001}),
                "split_audio": ("BOOLEAN", {"default": False}),
                # IMAGE batch / VIDEO (D-205): clip (player + timeline) or pictures (gallery). auto = a VIDEO is a clip, a batch when it moves.
                "as_clip": (CLIP_MODES, {"default": "auto"}),
                # the clip's fps. fps_auto = the node fills it with what the input says (the video's own, a VHS loader's, else 24);
                # typing one switches fps_auto off. On a VIDEO a different fps re-times it (same frames, another speed).
                "clip_fps": ("FLOAT", {"default": DEFAULT_FPS, "min": 0.01, "max": 1000.0, "step": 0.01}),
                "fps_auto": ("BOOLEAN", {"default": True}),
                # the volume of what goes OUT (output, audio, download, and the player, so you hear what you save). 1 = as it is.
                # How loud YOU hear it here is the frontend's Listen slider: never saved, never sent.
                "audio_gain": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01}),
            },
            # audio: plugged = the clip's sound, replacing whatever it had. The fps from a wire (D-233) = clip_fps's own socket
            # (the EXT ring; the browser then sends fps_auto off). fps_override is gone from here: an old prompt still passes it.
            "optional": {
                "audio": ("AUDIO",),
                # D-236: one picture only, a second one for the box's A|B (IMAGE with an IMAGE in, MASK with a MASK: the frontend
                # types the socket). Shown only, never sent on.
                "compare": (ANY,),
                # D-239: Start / End / Current as a FRAME number from a wire (the frame rings; the browser opens one at a time).
                # Plugged = it beats the seconds of its row (End = the last frame kept)
                "start_frame": ("INT", {"forceInput": True, "min": 0}),
                "end_frame": ("INT", {"forceInput": True, "min": 0}),
                "current_frame": ("INT", {"forceInput": True, "min": 0}),
                # D-230: which outputs are plugged, written by the browser into the prompt only (hidden field). Some outputs are
                # computed only when plugged (frame, audio, the gallery's frames): plugging one must change this node's key, or
                # ComfyUI would hand back the cached None. Never read here: the prompt says it already (wired_outputs).
                "succy_used": ("STRING", {"default": ""}),
            },
            # the node's id: one set of preview files per node, the old ones go away when the new ones land (no pile-up in temp/).
            # prompt: to see which outputs are wired, so a frame nobody reads is never decoded.
            "hidden": {"unique_id": "UNIQUE_ID", "prompt": "PROMPT"},
        }

    # The slots change with the input: "*" so every shape type-checks; the sockets the user sees are typed by the frontend
    # (shape_output). text: output · image: output, width, height, megapixels · audio: output, duration ·
    # video (D-239) and a batch (D-205 / D-234): the image four + audio, frame, duration.
    RETURN_TYPES = (ANY,) * 7
    RETURN_NAMES = ("output", "width", "height", "megapixels", "audio", "frame", "duration")
    FUNCTION = "execute"
    SUCCY_CACHE = "none"  # SmartCache (D-213): a viewer with files and players: ComfyUI's own cache is enough
    OUTPUT_NODE = True

    # -------------------------------------------------------------- #
    def execute(self, preview, source, output_type, invert_mask=False, trim_start=0.0, trim_end=0.0, current_time=0.0,
                split_audio=False, as_clip="auto", clip_fps=DEFAULT_FPS, fps_auto=True, audio_gain=1.0, audio=None, fps_override=None,
                unique_id=None, prompt=None, _view=False, succy_used="", compare=None, start_frame=None, end_frame=None, current_frame=None):
        # _view (D-205d): the As clip switch, live, from the route: only what the box shows, nothing computed for downstream
        self._view = bool(_view)
        self._fr = (start_frame, end_frame, current_frame)  # the frame rings (D-239): turned into seconds once the fps is known
        if not _view:
            _remember_run(source, audio, dict(preview=preview, output_type=output_type, invert_mask=invert_mask, trim_start=trim_start,
                          trim_end=trim_end, current_time=current_time, split_audio=split_audio, as_clip=as_clip, clip_fps=clip_fps,
                          fps_auto=fps_auto, audio_gain=audio_gain, fps_override=fps_override, unique_id=unique_id, prompt=prompt,
                          start_frame=start_frame, end_frame=end_frame, current_frame=current_frame))
        combined = vhs_combine_file(source)                 # VHS Video Combine's Filenames: we play the file it wrote
        if combined:
            source = _video_from_file(combined)
        if isinstance(source, Mapping) and not isinstance(source, dict):      # VHS's lazy audio
            source = as_audio(source)
            if source is None:
                _keep_files(_node_key(unique_id), [])
                return {"ui": {"succy_text": ["AUDIO: this clip has no sound track (VHS gives an empty audio for a silent video)."]},
                        "result": (None,) * 7}
        mode = as_clip if as_clip in CLIP_MODES else "auto"
        audio_in = as_audio(audio) if audio is not None else None
        fps_of = lambda found, where: pick_fps(fps_override, fps_auto, clip_fps, found, where)
        kind = media_kind(source)
        if kind == "video" and mode == "images":           # a video as pictures: As clip is only how the box SHOWS it (D-233)
            try:
                shown = self._video_gallery(source, _VideoInfo(source), preview, unique_id)
                if self._view:                                  # the live switch: the gallery, nothing for downstream
                    return shown
                # the outputs follow Convert To, exactly as with the clip on show (the gallery's files are kept alongside)
                r = self._media(kind, False, source, output_type, trim_start, trim_end, current_time, split_audio, unique_id, prompt,
                                fps_of=fps_of, audio_in=audio_in, gain=audio_gain, also=_PREVIEW_FILES.get(_node_key(unique_id), []))
                return {"ui": shown["ui"], "result": r["result"]}
            except Exception as ex:
                print(f"[PreviewAny] video as pictures failed, showing the clip: {ex}")
        if kind:
            return self._media(kind, preview, source, output_type, trim_start, trim_end, current_time, split_audio, unique_id, prompt,
                               fps_of=fps_of, audio_in=audio_in, gain=audio_gain)
        # Pictures (D-234): a BATCH (2+ images or masks) always hands on a clip's outputs (the kept frames, audio, frame,
        # duration, at the clip's fps): As clip only picks the box, player or gallery. One picture = the picture four (a VIDEO
        # out of one picture comes only from an old saved prompt: still made, through the clip).
        batch_out = gallery_fps = None
        if output_type in ("IMAGE", "MASK", "VIDEO") and isinstance(source, torch.Tensor) and source.dim() in (3, 4):
            n_in = int(source.shape[0])
            if n_in >= 2 or output_type == "VIDEO":
                try:
                    frames_src = source if source.dim() == 4 else source.unsqueeze(-1).expand(*source.shape, 3)
                    vhs = vhs_clip(prompt, unique_id)            # frames straight out of a VHS loader: its fps and its sound
                    fps, where = fps_of(vhs[0] if vhs else 0.0, "VHS" if vhs else "")
                    show_clip = mode == "clip" or (mode == "auto" and (output_type == "VIDEO" or bool(vhs) or looks_like_video(frames_src)))
                    if show_clip or n_in < 2:
                        return self._frames(frames_src, fps, where, vhs, audio_in, preview, output_type, invert_mask,
                                            trim_start, trim_end, current_time, unique_id, prompt, gain=audio_gain)
                    # the gallery: the same outputs as the clip, the box shows the pictures (written below)
                    batch_out = self._frames(frames_src, fps, where, vhs, audio_in, False, output_type, invert_mask,
                                             trim_start, trim_end, current_time, unique_id, prompt, gain=audio_gain)["result"]
                    gallery_fps = fps
                except Exception as ex:                      # the clip went wrong: pictures, as before. Never a dead queue.
                    print(f"[PreviewAny] batch outputs failed, showing pictures: {ex}")
        if output_type == "VIDEO":                           # the gallery of a batch sent on as VIDEO shows the pictures
            output_type = "IMAGE"
        converted = source
        width = height = 0
        megapixels = 0.0
        info_string = ""
        text_output = ""
        ui_images = []
        ui_gallery = None
        ui_compare = None

        if source is None:
            return {
                "ui": {"succy_text": ["No input detected."]},
                "result": (converted, width, height, megapixels, None, None, None),
            }

        # ---------- IMAGE / MASK ----------
        if output_type in ("IMAGE", "MASK"):
            if not isinstance(source, torch.Tensor):
                text_output = "Warning: Input is not a valid Tensor."
                info_string = text_output
            else:
                if source.dim() == 2:           # single mask [H, W] -> [1, H, W]
                    source = source.unsqueeze(0)
                shape = source.shape
                dims = len(shape)
                is_mask = dims == 3
                is_image = dims == 4

                if is_mask:
                    batch, height, width = shape
                    channels = 1
                elif is_image:
                    batch, height, width, channels = shape
                else:
                    batch = 1
                    height = width = channels = 0

                val_min = float(torch.min(source))
                val_max = float(torch.max(source))
                megapixels = (width * height) / 1_000_000.0

                info_string = (
                    f"Type: {'MASK' if is_mask else 'IMAGE'}\n"
                    f"Batch: {batch}\n"
                    f"Resolution: {width} x {height}\n"
                    f"Channels: {channels}\n"
                    f"Megapixels: {megapixels:.4f}\n"
                    f"Min Val: {val_min:.3f}\n"
                    f"Max Val: {val_max:.3f}"
                )
                text_output = info_string

                # Tensor conversion
                if is_image and output_type == "MASK":
                    converted = source[:, :, :, 0]
                elif is_mask and output_type == "IMAGE":
                    converted = (
                        source
                        .reshape((-1, 1, source.shape[-2], source.shape[-1]))
                        .movedim(1, -1)
                        .expand(-1, -1, -1, 3)
                    )
                else:
                    converted = source

                # MASK + INVERT: white <-> black. Done on the converted mask, so image -> mask -> invert works in one go.
                invert_shown = bool(invert_mask) and output_type == "MASK"
                if invert_shown:
                    converted = 1.0 - converted

                # PNG preview: only with preview ON (the pane is hidden otherwise, so nobody would look at it).
                # One live file per node: the previous one is deleted as soon as the new one is written.
                try:
                    if not preview:
                        raise _SkipPreview()
                    temp_dir = folder_paths.get_temp_directory()
                    node_key = _node_key(unique_id)
                    filename = _temp_name(node_key, "img", "png")
                    file_path = os.path.join(temp_dir, filename)

                    shown = converted if invert_shown else source      # inverted mask: preview what comes out
                    # grayscale and RGBA handled: the alpha is KEPT (D-106: a Crop cutout previewed as RGB looked uncut)
                    _to_pil(shown[0]).save(file_path, compress_level=4)
                    files = [filename]
                    # A|B (D-236): one picture + a compare picture plugged = its first frame, beside ours (shown only)
                    if int(shown.shape[0]) == 1 and isinstance(compare, torch.Tensor) and compare.dim() in (3, 4) and int(compare.shape[0]) >= 1:
                        try:
                            cname = _temp_name(node_key, "cmp", "png")
                            _to_pil(compare[0]).save(os.path.join(temp_dir, cname), compress_level=4)
                            files.append(cname)
                            ui_compare = _saved(cname)
                        except Exception as e:
                            print(f"[PreviewAny] compare error: {e}")
                    if int(shown.shape[0]) > 1:                        # a batch: the gallery of all of it, served frame by frame (D-205c)
                        try:
                            token = f"{random.randint(0, 1 << 30):x}"
                            _remember(_GALLERY, node_key, (weakref.ref(shown), token))
                            ui_gallery = {"key": node_key, "token": token, "total": int(shown.shape[0])}
                            if gallery_fps:                    # the frame picked in the gallery = `frame` (current_time = index / fps)
                                ui_gallery["fps"] = float(gallery_fps)
                        except Exception as e:
                            print(f"[PreviewAny] gallery error: {e}")
                    _keep_files(node_key, files + _player_kept(node_key))     # the clip's player stays: back to On = no re-encode

                    ui_images = [{
                        "filename": filename,
                        "subfolder": "",
                        "type": "temp",
                    }]
                except _SkipPreview:
                    pass
                except Exception as e:
                    print(f"[PreviewAny] Image preview error: {e}")

        # ---------- TEXT ----------
        else:
            try:
                if output_type in ("STRING", "COMBO"):
                    converted = _to_text(source)
                elif output_type == "INT":
                    converted = _parse_int(source)
                elif output_type == "FLOAT":
                    converted = _parse_float(source)
                elif output_type == "BOOLEAN":
                    converted = parse_bool(source)
                elif output_type in _UI_CONTAINER_TYPES:
                    if isinstance(source, str):
                        converted = to_container(source, output_type)
                    else:
                        converted = to_container(source, output_type)
            except Exception as e:
                print(f"[PreviewAny] Conversion error for {output_type}: {e}")

            text_output = _to_text(converted)

        if not ui_images:                   # nothing to show any more: the files of the previous run (picture, video) go
            _keep_files(_node_key(unique_id), [])
            _PLAYER.pop(_node_key(unique_id), None)

        # ---------- UI RESPONSE ----------
        # "succy_*" keys: custom, handled by the dedicated JS (not by the native UI).
        # Text always goes out; the picture only with preview ON (see above).
        ui_res = {}
        if ui_images:
            ui_res["succy_images"] = ui_images
            ui_res["succy_info"] = [
                f"Width: {width}   Height: {height}   Megapixels: {megapixels:.2f}"
                + (f"   ·   {ui_gallery['total']} images" if ui_gallery else "")
            ]
            if ui_gallery:
                ui_res["succy_gallery"] = [ui_gallery]
            if ui_compare:
                ui_res["succy_compare"] = [ui_compare]
            if preview and _LOG:
                print("\n" + "=" * 40)
                print("PreviewAny [IMAGE]:")
                print(info_string)
                print("=" * 40 + "\n")
        elif output_type not in ("IMAGE", "MASK") or text_output:
            # sent even when empty: the frontend refreshes the content anyway
            ui_res["succy_text"] = [text_output]
            if preview and _LOG:
                print("\n" + "=" * 40)
                print(f"PreviewAny [{output_type}]:")
                print(text_output)
                print("=" * 40 + "\n")

        return {
            "ui": ui_res,
            "result": batch_out if batch_out is not None else (converted, width, height, megapixels, None, None, None),
        }

    def _needs(self, slot, prompt, unique_id):
        """Does somebody downstream read output `slot`? Can't tell = yes. The live switch (_view) feeds nobody."""
        if getattr(self, "_view", False):
            return False
        wired = wired_outputs(prompt, unique_id)
        return wired is None or slot in wired

    def _video_gallery(self, source, vi, preview, unique_id):
        """A VIDEO as pictures with nobody reading the frames (D-205d): the first frame + a gallery served one frame at a time
        straight from the video. Nothing decoded up front: the switch is instant, the Run too."""
        node_key = _node_key(unique_id)
        W, H, n = vi.width, vi.height, vi.frames
        mp = (W * H) / 1_000_000.0
        ui = {"succy_text": [f"Type: VIDEO as pictures\nResolution: {W} x {H}\nFrames: {n}\nFPS: {vi.fps:.3f}"]}
        if preview:
            try:
                vf = _VideoFrames(source, n, vi.fps)
                name = _temp_name(node_key, "img", "png")
                first = vf.get(0, 0)
                if first is None:
                    raise ValueError("no frame could be read")
                first.save(os.path.join(folder_paths.get_temp_directory(), name), compress_level=4)
                token = f"{random.randint(0, 1 << 30):x}"
                old = _GALLERY.get(node_key)
                if old and isinstance(old[0], _VideoFrames):
                    old[0].close()
                _remember(_GALLERY, node_key, (vf, token))
                _keep_files(node_key, [name] + _player_kept(node_key))
                ui = {"succy_images": [_saved(name)], "succy_gallery": [{"key": node_key, "token": token, "total": n, "fps": float(vi.fps)}],
                      "succy_info": [f"Width: {W}   Height: {H}   Megapixels: {mp:.2f}   ·   {n} images"]}
            except Exception as ex:
                print(f"[PreviewAny] video gallery error: {ex}")
        return {"ui": ui, "result": (None, W, H, mp, None, None, None)}

    # -------------------------------------------------------------- #
    def _media(self, kind, preview, source, output_type, trim_start, trim_end, current_time, split_audio, unique_id, prompt,
               fps_of=None, audio_in=None, gain=1.0, also=()):
        """VIDEO / AUDIO in (D-198). `output` = the clip with everything applied: the window [trim_start, trim_end) really cut
        (frames and samples), split_audio = silent, Convert To = the container (video) or the download file (audio).
        `frame` (video) = the frame under current_time, which always sits inside the window. `duration` = seconds of what
        goes out (3 decimals). `audio` = the window's sound (D-239: always, like a batch; split_audio = `output` silent). The player shows the WHOLE clip (the timeline
        needs all of it); the download button gets exactly `output`. D-205: a VIDEO at another fps (field / EXT wire) is
        re-timed, a plugged `audio_in` replaces its sound: both rebuild the video from its frames before anything else.
        D-233, Convert To is a bridge: VIDEO (the old video.X = VIDEO in container X) · IMAGE = the window's frames (+ its sound
        on `audio`, like a VHS loader) · AUDIO = the window's sound. `also` = files somebody else shows (the gallery): kept."""
        node_key = _node_key(unique_id)
        need = lambda slot: self._needs(slot, prompt, unique_id)
        media = {"kind": kind}
        files = []
        temp = folder_paths.get_temp_directory()

        g = gain_value(gain)
        if kind == "audio":
            heard = source
            source = gain_audio(source, g)               # the volume of what goes out (and of what the player plays)
            sr = int(source["sample_rate"])
            n_s = int(source["waveform"].shape[-1])
            duration = n_s / sr if sr else 0.0
            s, e, trimmed = trim_window(duration, 0, trim_start, trim_end)
            out_audio = slice_audio(source, s, e) if trimmed else source
            ext = fmt_ext(output_type, "wav")
            if ext not in _AENC and ext != "wav":
                ext = "wav"
            channels = int(source["waveform"].shape[1]) if source["waveform"].dim() == 3 else 1
            dur_out = round(float(out_audio["waveform"].shape[-1]) / sr, 3) if sr else 0.0
            info = (f"Type: AUDIO\nSample rate: {sr} Hz\nChannels: {channels}\nDuration: {duration:.3f} s\n"
                    f"Selection: {s:.3f} -> {e:.3f} s\nOut: {dur_out:.3f} s as .{ext}")
            media.update(duration=duration, fps=0, gain=g, sample_rate=sr, channels=channels, start=s, end=e, trimmed=trimmed,
                         peaks=audio_peaks(source["waveform"]), format="audio.wav")
            line = f"{duration:.3f} s · {sr} Hz · {channels} ch"
            if preview:
                try:
                    play = _player_file(node_key, heard, "aud", "wav", lambda path: write_wav(path, source), sig=round(g, 3))
                    files.append(play)
                    dl = play
                    if trimmed or ext != "wav":
                        dl = _temp_name(node_key, "cut", ext)
                        write_audio(os.path.join(temp, dl), out_audio, ext)
                        files.append(dl)
                    media.update(src=_saved(play), dl=_saved(dl))
                except Exception as ex:
                    print(f"[PreviewAny] Audio preview error: {ex}")
            _keep_files(node_key, files + list(also))
            result = (out_audio, dur_out, None, None, None, None, None)
        else:
            vi = _VideoInfo(source)
            _remember(_CLIPS, node_key, {"kind": "video", "ref": weakref.ref(source), "auto_fps": vi.fps, "audio_in": audio_in, "gain": gain})
            fps, where = fps_of(vi.fps, "video") if fps_of else (vi.fps, "video")
            orig, ready = source, None
            ready = None                                     # the live switch (D-205d): this re-timing is already on disk
            if audio_in is not None or abs(fps - vi.fps) > 1e-3 or (abs(g - 1.0) > 1e-6 and vi.has_audio is not False):
                sig = _retime_sig(fps, audio_in, g)
                ready = _retimed_file(node_key, source, sig) if getattr(self, "_view", False) else None
            if ready:                                        # its player IS the re-timed video: opened lazily, nothing decoded
                source = _video_from_file(os.path.join(temp, ready))
                vi = _VideoInfo(source)
                vi.fps, vi.duration = fps, vi.frames / fps
            elif audio_in is not None or abs(fps - vi.fps) > 1e-3 or (abs(g - 1.0) > 1e-6 and vi.has_audio is not False):
                vi.check_decode(vi.frames)
                c = vi.components()
                from fractions import Fraction
                snd = slice_audio(audio_in, 0.0, vi.frames / fps) if audio_in is not None else c.audio    # never longer than the frames
                snd = gain_audio(snd, g)
                source = _make_video(c.images, snd, Fraction(fps).limit_denominator(1001))
                vi = _VideoInfo(source)
                vi.fps = fps                                 # the asked rate, exactly (the Fraction may round it)
                vi.duration = vi.frames / fps
            fps, n = vi.fps, vi.frames
            trim_start, trim_end, current_time = frame_times(fps, trim_start, trim_end, current_time, getattr(self, "_fr", (None,) * 3))
            s, e, trimmed = trim_window(vi.duration, fps, trim_start, trim_end)
            f0, f1 = frame_range(s, e, fps, n)
            fc = min(max(frame_at(current_time, fps, n), f0), f1 - 1)          # the current frame never leaves the window
            want = output_type if output_type in ("IMAGE", "AUDIO") else "VIDEO"
            split = bool(split_audio) and want == "VIDEO"
            src_fmt = video_format_of(source)
            ext = fmt_ext(output_type, src_fmt)
            if ext not in _VENC:
                ext = src_fmt if src_fmt in _VENC else "mp4"
            out_video = vi.window(f0, f1) if trimmed else source
            cut = {}

            def comps():                    # the window decoded ONCE, only if some output really needs tensors
                if "c" not in cut:
                    vi.check_decode(f1 - f0)
                    cut["c"] = out_video.get_components()
                return cut["c"]

            def window_sound():             # the window's sound, silence when the clip has none
                quiet = silent_audio((f1 - f0) / fps if fps else 0.0)
                return quiet if vi.has_audio is False else (comps().audio or quiet)

            audio = window_sound() if split or need(4) else None          # D-239: the window's sound, always on `audio`
            made = None
            if want == "VIDEO" and ext != src_fmt or (split and ext != "gif") or (trimmed and ext not in ("mp4", "mkv", "webm")):
                # a real file in the chosen container (silent with split): what comes out IS what the download saves
                made = _temp_name(node_key, "out", ext)
                _save_as(out_video, os.path.join(temp, made), ext, comps, fps, keep_audio=not split)
                out_video = _video_from_file(os.path.join(temp, made))
                files.append(made)
            dur_out = round((f1 - f0) / fps, 3) if fps else round(e - s, 3)
            info = (f"Type: VIDEO\nResolution: {vi.width} x {vi.height}\nFPS: {fps:.3f}\nDuration: {vi.duration:.3f} s\n"
                    f"Frames: {n}\nFormat: {src_fmt}\nAudio: {'yes' if vi.has_audio else 'no' if vi.has_audio is False else '?'}\n"
                    f"Selection: {s:.3f} -> {e:.3f} s (frames {f0} -> {f1 - 1})\n" + (f"Current frame: {fc}\n" if need(5) else "")
                    + (f"Out: {dur_out:.3f} s as .{ext}" + (" (silent)" if split else "") if want == "VIDEO"
                       else f"Out: {f1 - f0} frames as IMAGE (+ its sound on audio)" if want == "IMAGE" else f"Out: {dur_out:.3f} s as AUDIO"))
            frame = vi.frame(fc) if need(5) else None
            media.update(duration=vi.duration, fps=fps, fps_from=where, gain=g, key=node_key, frames=n, width=vi.width, height=vi.height, has_audio=vi.has_audio,
                         start=s, end=e, trimmed=trimmed, split=split, format="video." + src_fmt)
            line = (f"{vi.width}×{vi.height} · {fps:.2f} fps{_fps_note(where)} · {vi.duration:.3f} s · {n} frames · {src_fmt}"
                    + (" · audio" if vi.has_audio else ""))
            if preview:
                try:
                    play = ready or _player_file(node_key, source, "vid", "mp4", lambda path: _save_video(source, path))
                    if source is not orig:                   # re-timed: remembered, so Off -> On at this fps is instant
                        _remember(_RETIMED, node_key, (_ref(orig), _retime_sig(fps, audio_in, g), play))
                    files.append(play)
                    dl = made or play
                    if not made and (out_video is not source or ext != "mp4"):      # the download in the very format of `output`
                        dl = _temp_name(node_key, "cut", ext)
                        _save_as(out_video, os.path.join(temp, dl), ext, comps, fps, keep_audio=True)
                        files.append(dl)
                    media.update(src=_saved(play), dl=_saved(dl))
                except Exception as ex:
                    print(f"[PreviewAny] Video preview error: {ex}")
            _keep_files(node_key, files + list(also))
            out = (out_video if want == "VIDEO" else (comps().images if need(0) else None) if want == "IMAGE"
                   else window_sound() if need(0) else None)
            result = (out, vi.width, vi.height, (vi.width * vi.height) / 1_000_000.0, audio, frame, dur_out)    # the batch's seven (D-239)

        if preview and _LOG:
            print("\n" + "=" * 40 + f"\nPreviewAny [{kind.upper()}]:\n{info}\n" + "=" * 40 + "\n")
        return {"ui": {"succy_media": [media], "succy_info": [line], "succy_text": [info]}, "result": result}

    # -------------------------------------------------------------- #
    def _frames(self, source, fps, where, vhs, audio_in, preview, output_type, invert_mask, trim_start, trim_end, current_time,
                unique_id, prompt, gain=1.0):
        """An IMAGE batch shown as the clip it is (D-203 for VHS, D-205 for everyone): player + timeline at `fps`, its sound =
        the plugged `audio_in`, else the VHS loader's file (vhs = (fps, start, path, class)), else none. Handed on as what
        frame people expect: `output` = the frames of the kept window (IMAGE or MASK), width, height, megapixels, then
        `audio` (the window's sound, silence if none), `frame` (the one under Current), `duration`."""
        n, H, W = int(source.shape[0]), int(source.shape[1]), int(source.shape[2])
        duration = n / fps
        trim_start, trim_end, current_time = frame_times(fps, trim_start, trim_end, current_time, getattr(self, "_fr", (None,) * 3))
        s, e, trimmed = trim_window(duration, fps, trim_start, trim_end)
        f0, f1 = frame_range(s, e, fps, n)
        fc = min(max(frame_at(current_time, fps, n), f0), f1 - 1)
        need = lambda slot: self._needs(slot, prompt, unique_id)
        node_key = _node_key(unique_id)
        temp = folder_paths.get_temp_directory()

        full_audio, snd = _frames_sound(vhs, audio_in, duration, preview or need(4))
        has_audio = full_audio is not None
        full_audio = gain_audio(full_audio, gain)          # the volume of what goes out (the player plays it too)
        frames = source[f0:f1]
        out = frames
        if output_type == "MASK":
            out = frames[:, :, :, 0]
            if invert_mask:
                out = 1.0 - out
        win = (f1 - f0) / fps
        audio_out = slice_audio(full_audio, f0 / fps, f1 / fps) if has_audio else silent_audio(win)
        if output_type == "VIDEO":                          # D-233: the kept frames + their sound at this fps = a real VIDEO
            from fractions import Fraction
            out = _make_video(frames, audio_out if has_audio else None, Fraction(fps).limit_denominator(1001))
        frame = source[fc:fc + 1] if need(5) else None
        dur_out = round(win, 3)
        mp = (W * H) / 1_000_000.0
        origin = vhs[3] if vhs else "IMAGE batch"

        media = {"kind": "video", "duration": duration, "fps": fps, "fps_from": where, "gain": gain_value(gain), "key": node_key, "frames": n, "width": W, "height": H,
                 "has_audio": has_audio, "start": s, "end": e, "trimmed": trimmed, "split": False, "format": "video.mp4",
                 "frames_in": True, "vhs": bool(vhs)}
        line = f"{W}×{H} · {fps:.2f} fps{_fps_note(where)} · {duration:.3f} s · {n} frames" + (" · audio" if has_audio else "")
        info = (f"Type: IMAGE batch as a clip ({origin})\nResolution: {W} x {H}\nMegapixels: {mp:.4f}\nFPS: {fps:.3f} ({where or 'auto'})\n"
                f"Duration: {duration:.3f} s\nFrames: {n}\nAudio: {'yes' if has_audio else 'no'}\n"
                f"Selection: {s:.3f} -> {e:.3f} s (frames {f0} -> {f1 - 1})\n" + (f"Current frame: {fc}\n" if need(5) else "")
                + f"Out: {f1 - f0} frames, {dur_out:.3f} s as {output_type}")
        files = []
        _remember(_CLIPS, node_key, {"kind": "frames", "ref": weakref.ref(source), "auto_fps": vhs[0] if vhs else DEFAULT_FPS,
                                     "vhs": vhs, "audio_in": audio_in, "gain": gain})
        if preview:
            try:
                play = _player_file(node_key, source, "vid", "mp4", lambda p: encode_video(source, full_audio, fps, p, "mp4"),
                                    sig=_frames_sig(fps, snd, gain))
                files.append(play)
                dl = play
                if trimmed:                                  # the download = exactly the kept window, with its sound
                    dl = _temp_name(node_key, "cut", "mp4")
                    encode_video(frames, audio_out if has_audio else None, fps, os.path.join(temp, dl), "mp4")
                    files.append(dl)
                media.update(src=_saved(play), dl=_saved(dl))
            except Exception as ex:
                print(f"[PreviewAny] clip preview error: {ex}")
        _keep_files(node_key, files if preview else _player_kept(node_key))      # outputs only: the player stays for later
        if preview and _LOG:
            print("\n" + "=" * 40 + f"\nPreviewAny [FRAMES AS CLIP]:\n{info}\n" + "=" * 40 + "\n")
        return {"ui": {"succy_media": [media], "succy_info": [line], "succy_text": [info]},
                "result": (out, W, H, mp, audio_out, frame, dur_out)}


def _frames_sound(vhs, audio_in, duration, wanted=True):
    """A batch clip's sound for `duration` s: the plugged one (cut to length), else the VHS loader's file. (AUDIO or None, its
    signature for the player cache). Gain is applied by the caller."""
    if audio_in is not None:
        return slice_audio(audio_in, 0.0, duration), ("in", id(audio_in["waveform"]), round(duration, 4))
    if vhs and vhs[2] and wanted:
        try:
            return file_audio(vhs[2], vhs[1], duration), ("file", vhs[2], vhs[1], round(duration, 4))
        except Exception as ex:
            print(f"[PreviewAny] VHS audio could not be read: {ex}")
    return None, None


def _frames_sig(fps, snd, gain):
    return (round(float(fps), 4), snd, round(gain_value(gain), 3))


def _add_file(node_key, name):
    """One more temp file this node shows (Apply fps): the next Run cleans it up with the rest."""
    files = _PREVIEW_FILES.get(node_key, [])
    _keep_files(node_key, files + [name])


def _player_kept(node_key):
    """The clip player files of this node (plain and re-timed), while their source is still alive: kept on disk when the box
    shows pictures."""
    out = []
    for store, i in ((_PLAYER, 1), (_RETIMED, 2)):
        hit = store.get(node_key)
        try:
            if hit and hit[0]() is not None:
                out.append(hit[i])
        except Exception:
            pass
    return out


def _retime_sig(fps, audio_in, gain):
    return (round(float(fps), 4), id(audio_in["waveform"]) if audio_in is not None else None, round(gain_value(gain), 3))


def _retimed_file(node_key, video, sig):
    """The player file already made for this very video at this fps / sound / volume, or None."""
    hit = _RETIMED.get(node_key)
    try:
        ok = hit and hit[0]() is video and hit[1] == sig and os.path.isfile(os.path.join(folder_paths.get_temp_directory(), hit[2]))
    except Exception:
        ok = False
    return hit[2] if ok else None


def _remember_run(source, audio, kw):
    """What a Run got, for the live As clip switch (D-205d): batches and clips only (a text has nothing to switch)."""
    big = isinstance(source, torch.Tensor) and source.dim() in (3, 4) and int(source.shape[0]) >= 2
    if not (big or media_kind(source) == "video" or vhs_combine_file(source)):
        return
    _remember(_LAST, _node_key(kw.get("unique_id")), {"src": _ref(source), "audio": _ref(audio) if audio is not None else None, "kw": kw})


# what the browser may change for a live switch: the field and its type
_VIEW_FIELDS = {"as_clip": str, "output_type": str, "invert_mask": bool, "trim_start": float, "trim_end": float, "current_time": float,
                "split_audio": bool, "clip_fps": float, "fps_auto": bool, "audio_gain": float, "preview": bool}


def switch_view(key, fields):
    """As clip, live (D-205d): the node shows its last Run's input again with the browser's fields (As clip above all), without
    a Run and without computing anything for downstream. Returns the `ui` a Run would send. ValueError = Run again."""
    ctx = _LAST.get(str(key))
    src = ctx["src"]() if ctx else None
    if src is None:
        raise ValueError("this input is gone from memory: Run again")
    kw = dict(ctx["kw"])
    for k, cast in _VIEW_FIELDS.items():
        if k in (fields or {}) and fields[k] is not None:
            kw[k] = cast(fields[k])
    if kw.get("as_clip") not in CLIP_MODES:
        raise ValueError(f"As clip must be one of {CLIP_MODES}")
    audio = ctx["audio"]() if ctx["audio"] else None
    return Succy_Preview_Anything_Convert().execute(source=src, audio=audio, _view=True, **kw)["ui"]


def apply_fps(key, fps=None, auto=False):
    """Apply fps NOW, without a Run (D-205c): the player of the clip node `key` showed last is re-made at the new rate.
    Returns what the browser updates (fps, duration, frames, src). ValueError = nothing to re-time (Run again)."""
    ctx = _CLIPS.get(str(key))
    src = ctx["ref"]() if ctx else None
    if src is None:
        raise ValueError("this clip is gone from memory: Run again")
    target = float(ctx["auto_fps"]) if auto or not fps else float(fps)
    if not 0 < target <= 1000:
        raise ValueError(f"fps must be between 0 and 1000, not {fps}")
    key, temp = str(key), folder_paths.get_temp_directory()
    if ctx["kind"] == "frames":
        n = int(src.shape[0])
        full, snd = _frames_sound(ctx["vhs"], ctx["audio_in"], n / target)
        full = gain_audio(full, ctx["gain"])
        play = _player_file(key, src, "vid", "mp4", lambda p: encode_video(src, full, target, p, "mp4"), sig=_frames_sig(target, snd, ctx["gain"]))
        width, height = int(src.shape[2]), int(src.shape[1])
    else:
        vi = _VideoInfo(src)
        vi.check_decode(vi.frames)
        c = vi.components()
        n = vi.frames
        snd = slice_audio(ctx["audio_in"], 0.0, n / target) if ctx["audio_in"] is not None else c.audio
        full = gain_audio(snd, ctx["gain"])
        play = _temp_name(key, "vid", "mp4")
        encode_video(c.images, full, target, os.path.join(temp, play), "mp4")
        width, height = vi.width, vi.height
        _remember(_RETIMED, key, (_ref(src), _retime_sig(target, ctx["audio_in"], ctx["gain"]), play))
    _add_file(key, play)
    auto_from = "video" if ctx["kind"] == "video" else ("VHS" if ctx.get("vhs") else "default")
    return {"fps": target, "fps_from": auto_from if auto else "manual",
            "duration": n / target, "frames": n, "width": width, "height": height, "has_audio": full is not None,
            "src": _saved(play), "dl": _saved(play), "trimmed": False}


def _fps_note(where):
    """The info line's word on where the fps came from: nothing when the video said it, otherwise (VHS) (manual) (wire) (default)."""
    return f" ({where})" if where and where != "video" else ""


# ------------------------------------------------------------------ #
#  Routes (D-205c): the gallery frame by frame, Apply fps right now    #
#  Registered once per server (a module reload must not add a twin). #
# ------------------------------------------------------------------ #
def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
        from _succy_common import same_origin
        srv = PromptServer.instance
        if getattr(srv, "_succy_preview_routes", False) is True:
            return
        srv._succy_preview_routes = True
    except Exception:
        return                                              # no server (tests, a broken install): the node still works, minus these

    @srv.routes.get("/succy/preview/frame")
    async def _frame(request):
        q = request.query
        try:
            side = int(q.get("side", _THUMB_SIDE))
            body = await asyncio.to_thread(gallery_frame, q.get("key", ""), q.get("token", ""), int(q.get("i", -1)), side)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
        if body is None:
            return web.json_response({"error": "expired: Run again"}, status=410)
        head = {"Cache-Control": "private, max-age=3600"}
        if q.get("download"):
            head["Content-Disposition"] = f'attachment; filename="succy_frame_{int(q.get("i", 0)):04d}.png"'
        return web.Response(body=body, content_type="image/png", headers=head)

    @srv.routes.post("/succy/preview/fps")
    async def _fps(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        try:
            data = await request.json()
            out = await asyncio.to_thread(apply_fps, data.get("key", ""), data.get("fps"), bool(data.get("auto")))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"error": f"could not re-time: {exc}"}, status=500)
        return web.json_response(out)


    @srv.routes.post("/succy/preview/view")
    async def _view(request):
        if not same_origin(request):
            return web.json_response({"error": "cross-origin request refused"}, status=403)
        try:
            data = await request.json()
            out = await asyncio.to_thread(switch_view, data.get("key", ""), data.get("fields") or {})
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except Exception as exc:
            return web.json_response({"error": f"could not switch: {exc}"}, status=500)
        return web.json_response(out)


_register_routes()


# Node names (and the class mapping) live ONLY in the pack's __init__.py (NODES). Nobody gets to name herself here, honey.
