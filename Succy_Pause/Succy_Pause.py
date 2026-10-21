import os
import time

import comfy.model_management
from aiohttp import web
from comfy_api.latest import io
from server import PromptServer

from _succy_common import DISPLAY, same_origin   # the shared drawer (loaded once by __init__.py)

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))

# Per-node pause state: {"<display_node_id>": "wait" | "stop" | "continue"}
# The key is the id SHOWN in the graph (the one the frontend knows): inside a loop the cloned
# nodes have a different internal unique_id, while the display id stays the original node's.
_NODE_STATES: dict[str, str] = {}

_LOOP_STARTS = ("Succy_LoopStart", "Succy_WhileStart")
_LOOP_ENDS = ("Succy_LoopEnd", "Succy_WhileEnd")


def _is_link(value) -> bool:
    return (isinstance(value, (list, tuple)) and len(value) == 2
            and isinstance(value[0], str) and isinstance(value[1], int))


def _display_id(dynprompt, unique_id) -> str:
    try:
        if dynprompt is not None and hasattr(dynprompt, "get_display_node_id"):
            return str(dynprompt.get_display_node_id(unique_id))
    except Exception:
        pass
    return str(unique_id)


def _is_in_loop(dynprompt, unique_id) -> bool:
    """True if the node sits INSIDE a Succy loop (downstream of a Start without its matching End upstream)."""
    if dynprompt is None:
        return False
    try:
        ancestors, stack = set(), [unique_id]
        while stack:
            nid = stack.pop()
            if nid in ancestors:
                continue
            ancestors.add(nid)
            node = dynprompt.get_node(nid)
            for value in (node or {}).get("inputs", {}).values():
                if _is_link(value) and value[0] not in ancestors:
                    stack.append(value[0])

        def cls(n):
            try:
                return dynprompt.get_node(n).get("class_type")
            except Exception:
                return None

        starts = [n for n in ancestors if cls(n) in _LOOP_STARTS]
        ends = [n for n in ancestors if cls(n) in _LOOP_ENDS]
        for start in starts:
            closed = False
            for end in ends:
                flow = dynprompt.get_node(end).get("inputs", {}).get("flow")
                if _is_link(flow) and flow[0] == start:
                    closed = True
                    break
            if not closed:
                return True
    except Exception as exc:
        print(f"Succy Pause: loop detection failed: {exc}")
    return False


def _notify_frontend(display_id: str, in_loop: bool) -> None:
    try:
        PromptServer.instance.send_sync(
            "succy-pause-info", {"node_id": display_id, "in_loop": bool(in_loop)}
        )
    except Exception as exc:
        print(f"Succy Pause: info emit failed: {exc}")


@PromptServer.instance.routes.post("/succy/pause/action")
async def _pause_action(request: web.Request) -> web.Response:
    """Receives the user's action (continue/stop) from the frontend."""
    if not same_origin(request):
        return web.json_response({"error": "cross-origin request refused"}, status=403)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "bad JSON"}, status=400)
    node_id = data.get("node_id") if isinstance(data, dict) else None
    action = data.get("action") if isinstance(data, dict) else None
    if node_id is None or action not in ("continue", "stop"):
        return web.json_response({"error": "node_id and action ('continue' | 'stop') required"}, status=400)
    _NODE_STATES[str(node_id)] = action
    return web.json_response({"status": "ok"})


@PromptServer.instance.routes.get("/succy/pause/ding.mp3")
async def _pause_ding(request: web.Request) -> web.Response:
    """Serves the ding.mp3 file for the pause sound."""
    file_path = os.path.join(_THIS_DIR, "ding.mp3")
    if os.path.exists(file_path):
        return web.FileResponse(file_path)
    return web.Response(status=404)



def _name_from_init(node_id: str, fallback: str) -> str:
    """V3 nodes carry their own display_name and it BEATS the NODE_DISPLAY_NAME_MAPPINGS of __init__.py.
    Names are written in ONE place (__init__.py NODES[...]["display"]); __init__ hands them over through the shared drawer
    (`DISPLAY`) before any node loads. No literal here unless that drawer is empty."""
    return DISPLAY.get(node_id) or fallback


class Succy_PauseExecution(io.ComfyNode):
    """Holds execution in place until the user presses Continue or Stop. She decides when it's over."""
    SUCCY_CACHE = "never"  # SmartCache (D-213): it waits for her on purpose

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="Succy_PauseExecution",
            display_name=_name_from_init("Succy_PauseExecution", "Succy - ⏸ Pause"),
            category="Succy Pack",
            search_aliases=["pause", "stop", "break", "wait", "continue", "resume"],
            description="Blocks execution in place until the user clicks Continue or Stop.",
            inputs=[
                io.AnyType.Input("input"),
                io.Boolean.Input(
                    "pause_flow", default=True,
                    tooltip="When false, passes through without pausing",
                ),
                io.Int.Input(
                    "timeout_seconds", default=60, min=1, max=3600, step=1,
                    tooltip="Auto-resolve the pause after this many seconds",
                ),
                io.Combo.Input(
                    "on_timeout",
                    options=["continue", "stop workflow"],
                    default="continue",
                    tooltip="What to do when the timeout expires",
                ),
                io.Boolean.Input(
                    "emit_sound", default=True,
                    tooltip="Play a ding when execution pauses at this node",
                ),
                io.String.Input(
                    "run_id", default="0_manual",
                    tooltip="Managed by the frontend",
                ),
            ],
            hidden=[h for h in (io.Hidden.unique_id, getattr(io.Hidden, "dynprompt", None)) if h is not None],
            outputs=[io.AnyType.Output("output")],
        )

    @classmethod
    def fingerprint_inputs(cls, input=None, pause_flow=True, run_id="", **kwargs):
        """When it really has to stop, the node must NEVER come from the cache: inside a loop the
        following iterations have identical inputs and would get skipped (no pause)."""
        if pause_flow and not str(run_id).endswith("_continue"):
            return float("nan")
        return "passthrough"

    @classmethod
    def execute(cls, input, pause_flow, timeout_seconds, on_timeout,
                emit_sound, run_id):
        dynprompt = getattr(cls.hidden, "dynprompt", None)
        unique_id = _display_id(dynprompt, cls.hidden.unique_id)

        # --- Immediate pass-throughs ---
        if not pause_flow:
            print(f"Succy Pause: node {unique_id} bypassed (pause_flow is off).")
            return io.NodeOutput(input)

        if run_id.endswith("_continue"):
            print(f"Succy Pause: node {unique_id} post-edit transit, passing through.")
            return io.NodeOutput(input)

        # --- Actual pause ---
        _NODE_STATES[unique_id] = "wait"
        in_loop = _is_in_loop(dynprompt, cls.hidden.unique_id)
        _notify_frontend(unique_id, in_loop)
        start_time = time.time()
        print(f"Succy Pause: node {unique_id} paused for {timeout_seconds}s...")

        try:
            while True:
                # ComfyUI's global Stop button (top right)
                comfy.model_management.throw_exception_if_processing_interrupted()

                if _NODE_STATES.get(unique_id, "wait") == "stop":
                    print(f"Succy Pause: node {unique_id} stopped by user.")
                    comfy.model_management.interrupt_current_processing()
                    return io.NodeOutput(input)

                if _NODE_STATES.get(unique_id) == "continue":
                    # "In place" resume: used inside loops (the cycle carries on from where it was).
                    print(f"Succy Pause: node {unique_id} resumed by user.")
                    return io.NodeOutput(input)

                if time.time() - start_time >= timeout_seconds:
                    if on_timeout == "continue":
                        print(f"Succy Pause: node {unique_id} timeout expired, continuing.")
                        return io.NodeOutput(input)
                    print(f"Succy Pause: node {unique_id} timeout expired, stopping workflow.")
                    comfy.model_management.interrupt_current_processing()
                    return io.NodeOutput(input)

                time.sleep(0.2)
        finally:
            _NODE_STATES.pop(unique_id, None)
