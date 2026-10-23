# Succy resource monitor backend v1.0.0 (D-262)
# The numbers behind the top-bar monitor (dev/src/Succy_TopBar.js):
#   GET /succy/monitor/stats -> cpu (total, per core, temperature), ram (ComfyUI models / ComfyUI process / other), disks
#   (the output folder's and the models folder's drive), one entry per CUDA GPU (load, temperature, watts, VRAM split in three:
#   models loaded by ComfyUI, torch's working memory, everything outside ComfyUI).
# Every source is optional: psutil (ComfyUI ships it), pynvml (nvidia-ml-py: load / temperature / watts), torch.cuda (VRAM).
# A missing one leaves its fields at None and the page hides that tile. One snapshot costs ~1 ms (no blocking calls).
# Loaded by succy_canvas_menu.py (so __init__.py stays untouched). She watches everything, darling: that's how she knows when to strike.
import os
import shutil
import threading

from aiohttp import web
from server import PromptServer

try:
    import psutil
except Exception:          # ComfyUI requires it; without it CPU / RAM read as None
    psutil = None

try:
    import torch
except Exception:
    torch = None

GB = 1024 ** 3
_nvml = {"ok": None, "mod": None}
_lock = threading.Lock()


def _gb(n):
    return None if n is None else round(float(n) / GB, 2)


def _pct(used, total):
    try:
        return round(100.0 * float(used) / float(total), 1) if total else None
    except Exception:
        return None


def nvml():
    """pynvml once, lazily; None when the driver library or the package is missing (AMD, Mac, CPU-only)."""
    with _lock:
        if _nvml["ok"] is None:
            try:
                import pynvml
                pynvml.nvmlInit()
                _nvml["mod"], _nvml["ok"] = pynvml, True
            except Exception:
                _nvml["ok"] = False
        return _nvml["mod"] if _nvml["ok"] else None


def cpu_temp(sensors):
    """The package temperature out of psutil.sensors_temperatures() (Linux; Windows gives nothing). None when unknown."""
    if not sensors:
        return None
    for key in ("coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz"):
        rows = sensors.get(key) or []
        for r in rows:
            label = (getattr(r, "label", "") or "").lower()
            if label.startswith(("package", "tctl", "tdie")) or key in ("cpu_thermal", "acpitz"):
                return round(float(r.current), 1)
        if rows:
            return round(float(rows[0].current), 1)
    return None


def read_cpu():
    if psutil is None:
        return None
    try:
        cores = psutil.cpu_percent(interval=None, percpu=True)     # since the previous call: never blocks
        total = round(sum(cores) / len(cores), 1) if cores else None
        temp = None
        try:
            temp = cpu_temp(psutil.sensors_temperatures()) if hasattr(psutil, "sensors_temperatures") else None
        except Exception:
            pass
        return {"pct": total, "cores": [round(c, 1) for c in cores], "temp": temp,
                "count": psutil.cpu_count(logical=True), "physical": psutil.cpu_count(logical=False)}
    except Exception:
        return None


def loaded_models():
    """ComfyUI's loaded models: [(name, bytes in VRAM, bytes offloaded to RAM, device)]. Empty when nothing is loaded."""
    out = []
    try:
        import comfy.model_management as mm
        for lm in list(getattr(mm, "current_loaded_models", []) or []):
            patcher = getattr(lm, "model", None)
            if patcher is None:
                continue
            try:
                total = int(patcher.model_size())
            except Exception:
                total = 0
            try:
                on_gpu = int(patcher.loaded_size())
            except Exception:
                on_gpu = total
            dev = str(getattr(lm, "device", "") or getattr(patcher, "load_device", ""))
            if not dev.startswith("cuda"):
                on_gpu = 0                           # a model "loaded" on the CPU lives in RAM entirely
            inner = getattr(patcher, "model", None)
            name = type(inner).__name__ if inner is not None else type(patcher).__name__
            out.append((name, on_gpu, max(0, total - on_gpu), dev))
    except Exception:
        pass
    return out


def split_vram(total, free, reserved, models_vram):
    """The three slices of one GPU's used VRAM, in bytes: ComfyUI models · ComfyUI working memory · outside ComfyUI.
    Classic engine: the weights sit inside torch's reserved pool (models <= reserved), the rest of the pool is working memory.
    New engines (ComfyUI 0.4x dynamic VRAM, D-263b): the weights live OUTSIDE torch's pool (reserved < models): then reserved is
    all working memory. Anything odd is clamped to what is used, never negative."""
    used = max(0, total - free)
    reserved, models_vram = max(0, reserved), max(0, models_vram)
    work = reserved - models_vram if reserved >= models_vram else reserved
    models = min(models_vram, used)
    work = min(work, used - models)
    return {"used": used, "models": models, "work": work, "other": used - models - work}


def split_ram(total, available, rss, models_ram):
    """RAM in bytes: ComfyUI models offloaded to RAM · the rest of the ComfyUI process · other programs."""
    used = max(0, total - available)
    rss = min(max(0, rss), used)
    models = min(max(0, models_ram), rss)
    return {"used": used, "models": models, "work": rss - models, "other": used - rss}


def read_ram(models):
    if psutil is None:
        return None
    try:
        vm = psutil.virtual_memory()
        rss = psutil.Process(os.getpid()).memory_info().rss
        s = split_ram(vm.total, vm.available, rss, sum(m[2] for m in models))
        return {"total": _gb(vm.total), "pct": _pct(s["used"], vm.total), **{k: _gb(v) for k, v in s.items()}}
    except Exception:
        return None


def _gpu_nvml(handle):
    nv = nvml()
    out = {"load": None, "temp": None, "watts": None, "watts_max": None}
    if nv is None or handle is None:
        return out
    for key, fn in (("load", lambda: nv.nvmlDeviceGetUtilizationRates(handle).gpu),
                    ("temp", lambda: nv.nvmlDeviceGetTemperature(handle, 0)),       # 0 = NVML_TEMPERATURE_GPU
                    ("watts", lambda: round(nv.nvmlDeviceGetPowerUsage(handle) / 1000.0, 1)),
                    ("watts_max", lambda: round(nv.nvmlDeviceGetEnforcedPowerLimit(handle) / 1000.0, 1))):
        try:
            out[key] = fn()
        except Exception:
            pass
    return out


def _nvml_handle(i):
    """The NVML handle of torch's cuda:i (by PCI bus when torch knows it: CUDA_VISIBLE_DEVICES reorders the indices)."""
    nv = nvml()
    if nv is None:
        return None
    try:
        bus = getattr(torch.cuda.get_device_properties(i), "pci_bus_id", None)
        if bus:
            return nv.nvmlDeviceGetHandleByPciBusId(str(bus).encode() if isinstance(bus, str) else bus)
    except Exception:
        pass
    try:
        return nv.nvmlDeviceGetHandleByIndex(i)
    except Exception:
        return None


def read_gpus(models):
    if torch is None:
        return []
    try:
        if not torch.cuda.is_available():
            return []
        n = int(torch.cuda.device_count())
    except Exception:
        return []
    gpus = []
    for i in range(n):
        try:
            free, total = torch.cuda.mem_get_info(i)
            reserved = torch.cuda.memory_reserved(i)
            mine = sum(m[1] for m in models if m[3] == f"cuda:{i}" or (i == 0 and m[3] == "cuda"))
            s = split_vram(total, free, reserved, mine)
            g = {"index": i, "name": torch.cuda.get_device_name(i), "total": _gb(total), "pct": _pct(s["used"], total),
                 **{k: _gb(v) for k, v in s.items()}}
            g.update(_gpu_nvml(_nvml_handle(i)))
            gpus.append(g)
        except Exception:
            continue
    return gpus


def _folder(kind):
    try:
        import folder_paths
        if kind == "output":
            return folder_paths.get_output_directory()
        return folder_paths.models_dir
    except Exception:
        return None


def read_disks():
    """The drive of the output folder and the one of the models folder (once if they are the same drive)."""
    out, seen = [], set()
    for kind in ("output", "models"):
        path = _folder(kind)
        if not path:
            continue
        try:
            path = os.path.abspath(path)
            dev = os.stat(path).st_dev
            if dev in seen:
                for d in out:
                    if d["dev"] == dev:
                        d["role"] += " + " + kind
                continue
            seen.add(dev)
            u = shutil.disk_usage(path)
            out.append({"role": kind, "path": path, "dev": dev, "total": _gb(u.total), "used": _gb(u.used),
                        "free": _gb(u.free), "pct": _pct(u.used, u.total)})
        except Exception:
            continue
    for d in out:
        d.pop("dev", None)
    return out


def snapshot():
    models = loaded_models()
    return {
        "v": 1,
        "cpu": read_cpu(),
        "ram": read_ram(models),
        "gpus": read_gpus(models),
        "disks": read_disks(),
        "models": [{"name": m[0], "vram": _gb(m[1]), "ram": _gb(m[2]), "device": m[3]} for m in models],
        "nvml": bool(nvml()),
    }


try:
    if psutil is not None:
        psutil.cpu_percent(interval=None, percpu=True)     # primes the counter: the first real reading is not a zero
except Exception:
    pass


@PromptServer.instance.routes.get("/succy/monitor/stats")
async def _monitor_stats(request):
    try:
        return web.json_response(snapshot())
    except Exception as e:
        return web.json_response({"v": 1, "error": str(e)}, status=500)
