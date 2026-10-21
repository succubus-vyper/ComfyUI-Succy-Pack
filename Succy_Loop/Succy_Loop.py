"""Succy Pack loops — GraphBuilder for/while nodes for ComfyUI.

Succy_LoopStart / Succy_LoopEnd
-------------------------------
State travels inside the FLOW_CONTROL tuple. Do NOT mark that socket as
rawLink=True: ComfyUI would pass [node_id, slot] and the loop would run once.
"""

from __future__ import annotations

import math
import torch
from comfy_execution.graph_utils import GraphBuilder, is_link

try:
    from server import PromptServer
    _HAS_PROMPT_SERVER = True
except Exception:
    PromptServer = None
    _HAS_PROMPT_SERVER = False


from _succy_common import ANY   # the shared drawer (loaded once by __init__.py)

_FLOW_TAG = "SuccyFlow"
_STATE_TAG = "_succy"
_STATE_KIND = "loop"
_MAX_WHILE = 4096

# ---------------------------------------------------------------------------
# Frontend status events
# ---------------------------------------------------------------------------
def _succy_send(payload):
    if not _HAS_PROMPT_SERVER:
        return
    try:
        PromptServer.instance.send_sync("succy-loop-status", payload)
    except Exception as exc:
        print(f"[Succy Loop] status emit failed: {exc}")

def _emit_for_status(start_id, iteration, total, accumulate):
    if start_id is None:
        return
    _succy_send({
        "start_id": str(start_id),
        "kind": "for",
        "iteration": int(iteration),
        "total": int(total),
        "accumulate": bool(accumulate),
    })

def _emit_for_start(start_id, finished, total):
    """Loop Start announces the pass that is ABOUT to run (`finished` = passes already completed before it)."""
    if start_id is None:
        return
    _succy_send({
        "start_id": str(start_id),
        "kind": "for",
        "side": "start",
        "iteration": int(finished),
        "total": int(total),
    })

def _emit_for_done(start_id, total):
    if start_id is None:
        return
    _succy_send({
        "start_id": str(start_id),
        "kind": "for",
        "done": True,
        "total": int(total),
    })

def _emit_while_status(start_id, iteration, side, active_slots, condition=None, done=False):
    if start_id is None:
        return
    payload = {
        "start_id": str(start_id),
        "kind": "while",
        "side": side,
        "iteration": int(iteration),
        "active_slots": sorted(int(i) for i in active_slots),
        "done": bool(done),
    }
    if condition is not None:
        payload["condition"] = bool(condition)
    _succy_send(payload)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _display_id(dynprompt, node_id):
    """Id shown in the frontend (clones of nested loops have different internal ids)."""
    if node_id is None:
        return None
    try:
        if dynprompt is not None and hasattr(dynprompt, "get_display_node_id"):
            return dynprompt.get_display_node_id(node_id)
    except Exception:
        pass
    return node_id

def _is_flow(value):
    return (
        isinstance(value, (tuple, list))
        and len(value) == 2
        and value[0] == _FLOW_TAG
        and isinstance(value[1], dict)
        and value[1].get(_STATE_TAG) == _STATE_KIND
    )

def _make_flow(state):
    state[_STATE_TAG] = _STATE_KIND
    return (_FLOW_TAG, state)

def _read_state(flow):
    if _is_flow(flow):
        return flow[1]
    return None

def _is_raw_link(value):
    if is_link(value):
        return True
    return (
        isinstance(value, (tuple, list))
        and len(value) == 2
        and isinstance(value[1], int)
        and value[0] != _FLOW_TAG
    )

def _is_loop_state(value):
    return isinstance(value, dict) and value.get(_STATE_TAG) == _STATE_KIND

def _tensor_batch_to_list(value):
    if isinstance(value, torch.Tensor) and value.ndim >= 1 and value.shape[0] > 0:
        return [value[i : i + 1] for i in range(int(value.shape[0]))]

    if isinstance(value, dict) and isinstance(value.get("samples"), torch.Tensor):
        samples = value["samples"]
        items = []
        for i in range(int(samples.shape[0])):
            item = dict(value)
            item["samples"] = samples[i : i + 1]
            items.append(item)
        return items

    return None

def _coerce_item_list(value):
    if value is None or _is_flow(value) or _is_loop_state(value):
        return None
    batched = _tensor_batch_to_list(value)
    if batched is not None:
        return batched
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return None

def _finalize_accum(items):
    if not items:
        return items
    if len(items) == 1:
        return items[0]

    first = items[0]
    if isinstance(first, torch.Tensor):
        try:
            return torch.cat(items, dim=0)
        except Exception as exc:
            raise RuntimeError(
                f"Succy_LoopEnd accumulate: cannot batch {len(items)} IMAGE/MASK "
                f"outputs ({exc}). Every iteration must return the same HxW."
            ) from exc

    if isinstance(first, dict) and isinstance(first.get("samples"), torch.Tensor):
        try:
            merged = dict(first)
            merged["samples"] = torch.cat([item["samples"] for item in items], dim=0)
            return merged
        except Exception as exc:
            raise RuntimeError(
                f"Succy_LoopEnd accumulate: cannot batch {len(items)} LATENT outputs ({exc})."
            ) from exc

    return items

# ---------------------------------------------------------------------------
# Node Implementations
# ---------------------------------------------------------------------------
class Succy_LoopStart:
    """Dynamic-graph loop opener."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "mode": (["simple", "for", "list", "ping-pong", "grid"],),
                "num_iterations": ("INT", {"default": 8, "min": 1, "max": 99999, "step": 1}),
            },
            "optional": {
                "state": (ANY,),
                "initial_iteration_value": (ANY,),
                # The direct override is kept for compatibility, but the new JS 
                # also handles the native "Convert to input" conversion just fine
                "iterations_override": ("INT", {"forceInput": True}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "dynprompt": "DYNPROMPT",
            },
        }

    RETURN_TYPES = ("FLOW_CONTROL", "INT", "BOOLEAN", "BOOLEAN", ANY, ANY)
    RETURN_NAMES = (
        "flow",
        "iteration_index",
        "is_first",
        "is_last",
        "list_item",
        "current_iteration_value",
    )
    FUNCTION = "start_loop"
    SUCCY_CACHE = "never"  # SmartCache (D-213): flow control: the loop decides
    CATEGORY = "Succy Pack/Loops"

    def start_loop(
        self,
        mode,
        num_iterations,
        state=None,
        initial_iteration_value=None,
        iterations_override=None,
        unique_id=None,
        dynprompt=None,
    ):
        # Priority to the override socket — it always gets its way
        if iterations_override is not None:
            try:
                ov = int(iterations_override)
                if ov > 0:
                    num_iterations = ov
            except (TypeError, ValueError):
                pass

        if not _is_loop_state(state):
            state = {
                _STATE_TAG: _STATE_KIND,
                "index": 0,
                "total": int(num_iterations),
                "num_iterations": int(num_iterations),
                "carry": initial_iteration_value,
                "accum": None,
                "start_id": _display_id(dynprompt, unique_id),
            }
            items = _coerce_item_list(initial_iteration_value)
            if mode == "list" and items is not None:
                state["items"] = items
        else:
            state = dict(state)  # never mutate state shared with other nodes. Hands off what isn't yours.

        idx = int(state.get("index", 0))
        total = int(state.get("total", num_iterations))

        if mode == "list":
            if not isinstance(state.get("items"), list):
                items = _coerce_item_list(state.get("items", initial_iteration_value))
                if items is not None:
                    state["items"] = items
            if isinstance(state.get("items"), list):
                total = max(1, len(state["items"]))
        elif mode == "ping-pong":
            n = int(state.get("num_iterations", num_iterations))
            total = (2 * n - 2) if n > 1 else 1
        elif mode == "grid":
            total = int(state.get("total", num_iterations))

        state["index"] = idx
        state["total"] = total
        if state.get("start_id") is None:
            state["start_id"] = _display_id(dynprompt, unique_id)
        state["num_iterations"] = int(num_iterations)

        if "carry" not in state:
            state["carry"] = initial_iteration_value

        is_first = idx == 0
        is_last = idx >= max(total - 1, 0)
        _emit_for_start(state.get("start_id"), idx, total)

        item = None
        if mode == "list":
            items = state.get("items")
            if isinstance(items, list) and 0 <= idx < len(items):
                item = items[idx]
        elif mode == "ping-pong":
            n = int(state.get("num_iterations", num_iterations))
            if n <= 1:
                item = 0
            elif idx < n:
                item = idx
            else:
                item = (2 * n - 2) - idx
        elif mode == "grid":
            cols = max(1, math.ceil(math.sqrt(max(total, 1))))
            item = (idx % cols, idx // cols)

        return (
            _make_flow(state),
            idx,
            is_first,
            is_last,
            item,
            state.get("carry"),
        )

class _LoopGraphMixin:
    @staticmethod
    def _get_node(dynprompt, node_id):
        if dynprompt is None or node_id is None:
            return None
        try:
            return dynprompt.get_node(node_id)
        except Exception:
            return None

    @staticmethod
    def _explore_dependencies(node_id, dynprompt, upstream, visiting=None):
        """Maps parent -> [children] walking up from node_id. Each node is visited ONCE
        (it used to be exponential on diamond graphs) and without recursion (no RecursionError)."""
        seen = set()
        stack = [node_id]
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            node_info = _LoopGraphMixin._get_node(dynprompt, current)
            if not node_info:
                continue
            for value in node_info.get("inputs", {}).values():
                if not is_link(value):
                    continue
                parent_id = value[0]
                children = upstream.setdefault(parent_id, [])
                if current not in children:
                    children.append(current)
                if parent_id not in seen:
                    stack.append(parent_id)

    @staticmethod
    def _collect_contained(node_id, upstream, contained):
        stack = [node_id]
        while stack:
            current = stack.pop()
            if current in contained:
                continue
            contained.add(current)
            stack.extend(upstream.get(current, ()))

    @classmethod
    def _resolve_start_id(cls, flow, dynprompt, unique_id):
        node_info = cls._get_node(dynprompt, unique_id)
        if node_info:
            flow_input = node_info.get("inputs", {}).get("flow")
            if is_link(flow_input):
                return flow_input[0]
        if _is_raw_link(flow):
            return flow[0]
        if _is_flow(flow):
            return flow[1].get("start_id")
        return None

    @classmethod
    def _build_next_iteration(cls, dynprompt, unique_id, flow, build_state, result_arity=1):
        start_id = cls._resolve_start_id(flow, dynprompt, unique_id)
        if start_id is None:
            print("[Succy Loop] cannot resolve LoopStart id; refusing to expand")
            return None

        upstream = {}
        cls._explore_dependencies(unique_id, dynprompt, upstream)

        contained = set()
        cls._collect_contained(start_id, upstream, contained)
        contained.add(unique_id)
        contained.add(start_id)

        if unique_id not in contained:
            print(
                f"[Succy Loop] LoopEnd {unique_id} is not downstream of "
                f"LoopStart {start_id}; refusing to expand"
            )
            return None

        graph = GraphBuilder()

        for node_id in contained:
            original = cls._get_node(dynprompt, node_id)
            if not original or "class_type" not in original:
                continue
            clone_id = "Recurse" if node_id == unique_id else node_id
            node = graph.node(original["class_type"], clone_id)
            if hasattr(node, "set_override_display_id"):
                node.set_override_display_id(node_id)

        for node_id in contained:
            original = cls._get_node(dynprompt, node_id)
            if not original:
                continue
            clone_id = "Recurse" if node_id == unique_id else node_id
            node = graph.lookup_node(clone_id)
            if node is None:
                continue
            for key, value in original.get("inputs", {}).items():
                if is_link(value) and value[0] in contained:
                    parent_id = "Recurse" if value[0] == unique_id else value[0]
                    parent = graph.lookup_node(parent_id)
                    if parent is None:
                        continue
                    node.set_input(key, parent.out(value[1]))
                else:
                    node.set_input(key, value)

        next_start = graph.lookup_node(start_id)
        if next_start is None:
            return None
        for key, value in build_state.items():
            next_start.set_input(key, value)

        recurse = graph.lookup_node("Recurse")
        if recurse is None:
            return None

        return {
            "result": tuple(recurse.out(i) for i in range(result_arity)),
            "expand": graph.finalize(),
        }

class Succy_LoopEnd(_LoopGraphMixin):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "flow": ("FLOW_CONTROL",),
                "output_value": (ANY,),
                "accumulate": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "next_iteration_value": (ANY,),
            },
            "hidden": {
                "dynprompt": "DYNPROMPT",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = (ANY,)
    RETURN_NAMES = ("outputs",)
    FUNCTION = "end_loop"
    SUCCY_CACHE = "never"  # SmartCache (D-213): flow control: the loop decides
    CATEGORY = "Succy Pack/Loops"

    def end_loop(
        self, flow, output_value, accumulate, next_iteration_value=None, dynprompt=None, unique_id=None
    ):
        state = _read_state(flow)

        if state is None:
            raise RuntimeError("Succy_LoopEnd missing flow state. Wire LoopStart.flow -> LoopEnd.flow")

        idx = int(state.get("index", 0))
        total = max(1, int(state.get("total", 1)))
        start_id = state.get("start_id")

        _emit_for_status(start_id, idx + 1, total, bool(accumulate))

        if idx >= total - 1:
            if accumulate:
                accum = state.get("accum")
                items = [output_value] if accum is None else (accum + [output_value])
                result = _finalize_accum(items)
            else:
                result = output_value
            _emit_for_done(start_id, total)
            return (result,)

        carried = output_value if next_iteration_value is None else next_iteration_value

        next_state = dict(state)
        next_state["index"] = idx + 1
        next_state["carry"] = carried
        if accumulate:
            accum = state.get("accum")
            next_state["accum"] = [output_value] if accum is None else accum + [output_value]
        else:
            next_state["accum"] = None

        expanded = self._build_next_iteration(
            dynprompt, unique_id, flow, {"state": next_state, "initial_iteration_value": carried}, 1
        )
        if not expanded:
            raise RuntimeError(f"Succy_LoopEnd could not clone the loop body (stuck at {idx + 1}/{total}).")
        return expanded

class Succy_WhileStart:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "state": (ANY,),
                "initial_value0": (ANY,), "initial_value1": (ANY,),
                "initial_value2": (ANY,), "initial_value3": (ANY,),
                "initial_value4": (ANY,),
            },
            "hidden": {"unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"},
        }
    RETURN_TYPES = ("FLOW_CONTROL", ANY, ANY, ANY, ANY, ANY)
    RETURN_NAMES = ("flow", "value0", "value1", "value2", "value3", "value4")
    FUNCTION = "start_while"
    SUCCY_CACHE = "never"  # SmartCache (D-213): flow control: the loop decides
    CATEGORY = "Succy Pack/Loops"

    def start_while(self, state=None, initial_value0=None, initial_value1=None, initial_value2=None, initial_value3=None, initial_value4=None, unique_id=None, dynprompt=None):
        if not _is_loop_state(state):
            state = {_STATE_TAG: _STATE_KIND, "iteration": 0, "start_id": _display_id(dynprompt, unique_id)}
        else:
            state = dict(state)
            if state.get("start_id") is None:
                state["start_id"] = _display_id(dynprompt, unique_id)

        values = (initial_value0, initial_value1, initial_value2, initial_value3, initial_value4)
        active = [i for i, v in enumerate(values) if v is not None]
        _emit_while_status(state.get("start_id"), state.get("iteration", 0), "start", active)
        return (_make_flow(state), *values)

class Succy_WhileEnd(_LoopGraphMixin):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "flow": ("FLOW_CONTROL",),
                "condition": ("BOOLEAN", {"forceInput": True}),
            },
            "optional": {
                "initial_value0": (ANY,), "initial_value1": (ANY,),
                "initial_value2": (ANY,), "initial_value3": (ANY,),
                "initial_value4": (ANY,),
            },
            "hidden": {"dynprompt": "DYNPROMPT", "unique_id": "UNIQUE_ID"},
        }
    RETURN_TYPES = (ANY, ANY, ANY, ANY, ANY)
    RETURN_NAMES = ("value0", "value1", "value2", "value3", "value4")
    FUNCTION = "end_while"
    SUCCY_CACHE = "never"  # SmartCache (D-213): flow control: the loop decides
    CATEGORY = "Succy Pack/Loops"

    def end_while(self, flow, condition, initial_value0=None, initial_value1=None, initial_value2=None, initial_value3=None, initial_value4=None, dynprompt=None, unique_id=None):
        values = (initial_value0, initial_value1, initial_value2, initial_value3, initial_value4)
        state = _read_state(flow)
        start_id = state.get("start_id") if state else None
        iteration = int(state.get("iteration", 0)) if state else 0
        active = [i for i, v in enumerate(values) if v is not None]

        if not condition:
            _emit_while_status(start_id, iteration, "end", active, condition=False, done=True)
            _emit_while_status(start_id, iteration, "start", active, done=True)
            return values

        if state is None:
            state = {_STATE_TAG: _STATE_KIND, "iteration": 0}

        _emit_while_status(start_id, iteration, "end", active, condition=True)
        iteration = int(state.get("iteration", 0)) + 1
        if iteration > _MAX_WHILE:
            raise RuntimeError(f"Succy_WhileEnd stopped after {_MAX_WHILE} iterations.")

        next_state = dict(state)
        next_state["iteration"] = iteration
        expanded = self._build_next_iteration(
            dynprompt, unique_id, flow,
            {"state": next_state, "initial_value0": initial_value0, "initial_value1": initial_value1, "initial_value2": initial_value2, "initial_value3": initial_value3, "initial_value4": initial_value4}, 5
        )
        if not expanded:
            raise RuntimeError("Succy_WhileEnd could not clone the loop body.")
        return expanded


NODE_CLASS_MAPPINGS = {
    "Succy_LoopStart": Succy_LoopStart,
    "Succy_LoopEnd": Succy_LoopEnd,
    "Succy_WhileStart": Succy_WhileStart,
    "Succy_WhileEnd": Succy_WhileEnd,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Succy_LoopStart": "⏯️ Succy Loop Start",
    "Succy_LoopEnd": "⏹️ Succy Loop End",
    "Succy_WhileStart": "🔄 Succy While Loop Start",
    "Succy_WhileEnd": "🔄 Succy While Loop End",
}