# ====================================================================== #
#  pb_engines.py — the V6 "Succubus Vyper Prompt Builder" engines, ported  #
#  1:1 (same rules, same order of choices, same texts). What changed:     #
#    * every engine takes its own `rng` (a random.Random): never the      #
#      process-wide `random`, so ComfyUI's RNG is left alone and a seed   #
#      gives the same result every time (V6 had no seed at all);          #
#    * the engines only READ the JSON dicts they are given, never write.  #
#  Marked "FIX D-365": the few V6 defects she agreed to correct.          #
#  A body, a wardrobe, a camera, a set and a mood: everything a girl      #
#  needs for a good picture, darling.                                     #
# ====================================================================== #
import re
from typing import Any, Dict, List, Optional

COMP_KEYS = ["framing", "camera_angle", "viewpoint", "aspect_ratio", "composition_rule", "subject_placement"]
BG_KEYS = ["bg_place", "bg_zone", "bg_time", "bg_epoch", "bg_atmosphere", "bg_activity"]
ACT_KEYS = ["kinetic_energy", "interaction_target", "narrative_tone", "npc_placement"]


def _list_of(cond_values: str) -> List[str]:
    return [v.strip().strip("'\"") for v in cond_values.split(",")]


class _Rules:
    """The rule language of Composition / Background / Action (hard_forbidden_combinations): AND, OR (not in Composition), IN, NOT IN, ==."""
    with_or = True

    def _evaluate_condition(self, condition: str, settings: Dict) -> bool:
        if " AND " in condition:
            return all(self._evaluate_condition(p.strip(), settings) for p in condition.split(" AND "))
        if self.with_or and " OR " in condition:
            return any(self._evaluate_condition(p.strip(), settings) for p in condition.split(" OR "))
        m = re.match(r"(\w+)\s+NOT\s+IN\s+\[(.*?)\]", condition)
        if m:
            return settings.get(m.group(1)) not in _list_of(m.group(2))
        m = re.match(r"(\w+)\s+IN\s+\[(.*?)\]", condition)
        if m:
            return settings.get(m.group(1)) in _list_of(m.group(2))
        if "==" in condition:
            left, right = condition.split("==")
            left, right = left.strip(), right.strip().strip("'\"")
            if self.typed_eq:                      # Composition only (V6): '3' -> 3, 'true' -> True
                if right.isdigit():
                    right = int(right) if "." not in right else float(right)
                elif right.lower() in ("true", "false"):
                    right = right.lower() == "true"
            return settings.get(left) == right
        return False

    typed_eq = False


# ---------------------------------------------------------------- composition
class CompositionEngine(_Rules):
    with_or = False
    typed_eq = True

    def __init__(self, spec: Dict[str, Any], rng):
        self.spec = spec or {}
        self.rng = rng
        self.parameters = self.spec.get("parameters", {})
        self.forbidden = self.spec.get("hard_forbidden_combinations", [])

    def _pick(self, param):
        values = self.parameters.get(param, {}).get("values", [])
        return self.rng.choice(values) if values else ""

    def generate_composition(self, fixed_settings: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        fixed_settings = fixed_settings or {}
        settings = fixed_settings.copy()
        for param in COMP_KEYS:                    # 1. only the free (blue) fields get a random value
            if param not in settings:
                settings[param] = self._pick(param)
        for _ in range(50):                        # 2. rules: fix the target, or (target locked) reroll everything free
            violations = self._check_hard_constraints(settings)
            if not violations:
                break
            for violation in violations:
                target = violation.get("reroll_target")
                if target and target not in fixed_settings:
                    settings = self._resolve_violation(settings, violation)
                else:
                    for k in COMP_KEYS:
                        if k not in fixed_settings:
                            settings[k] = self._pick(k)
        return settings

    def _check_hard_constraints(self, settings: Dict) -> List[Dict]:
        return [rule for rule in self.forbidden if self._evaluate_condition(rule["condition"], settings)]

    def _resolve_violation(self, settings: Dict, violation: Dict) -> Dict:
        # V6: the FIRST value of the target that breaks no rule (not a random one)
        if violation.get("action", "reroll") == "reroll" and "reroll_target" in violation:
            target = violation["reroll_target"]
            if target in self.parameters:
                values = self.parameters[target].get("values", [])
                for val in values:
                    test = dict(settings)
                    test[target] = val
                    if not self._check_hard_constraints(test):
                        settings[target] = val
                        return settings
                settings[target] = values[0] if values else ""
        return settings

    def compose_description(self, settings: Dict[str, str]) -> str:
        lab = lambda k: self.parameters.get(k, {}).get("labels", {}).get(settings.get(k, ""), "")
        framing, angle, viewpoint, ar = lab("framing"), lab("camera_angle"), lab("viewpoint"), lab("aspect_ratio")
        comp, place = lab("composition_rule"), lab("subject_placement")
        parts = []
        if framing:
            parts.append(framing)
        camera_parts = [x for x in (viewpoint, angle, ar) if x]
        if camera_parts:
            parts.append(", ".join(camera_parts))
        place_parts = [x for x in (place, comp) if x]
        if place_parts:
            parts.append(f"The subject is {' and '.join(place_parts)}")
        if not parts:
            return ""
        # FIX D-365 (her point 7): V6 split on every '.' (it broke "2.39:1") and lower-cased the rest of each sentence
        # ("Rule of Thirds" -> "Rule of thirds"). Now each PART is one sentence: first letter up, the rest as written.
        sentences = []
        for p in parts:
            p = p.strip().replace(" ,", ",").rstrip(".").strip()
            if p:
                sentences.append(p[0].upper() + p[1:])
        return ". ".join(sentences) + "."


# ---------------------------------------------------------------- background
class BackgroundEngine(_Rules):
    def __init__(self, spec: Dict[str, Any], rng):
        self.spec = spec or {}
        self.rng = rng
        self.parameters = self.spec.get("parameters", {})
        self.rules = self.spec.get("hard_forbidden_combinations", [])

    def _pick(self, param):
        values = self.parameters.get(param, {}).get("values", [])
        return self.rng.choice(values) if values else ""

    def generate_background(self, fixed_settings: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        # FIX D-365: V6 called this WITHOUT the locked fields and pasted them on top afterwards (rules could break).
        # Same code as V6's own, it was just never given them.
        fixed_settings = fixed_settings or {}
        settings = fixed_settings.copy()
        for param in BG_KEYS:
            if param not in settings:
                settings[param] = self._pick(param)
        for _ in range(50):
            violations = self._check_hard_constraints(settings)
            if not violations:
                break
            for violation in violations:
                target = violation.get("reroll_target")
                if target and target not in fixed_settings:
                    settings = self._resolve_violation(settings, violation)
                else:
                    for k in BG_KEYS:
                        if k not in fixed_settings:
                            settings[k] = self._pick(k)
        return settings

    def _check_hard_constraints(self, settings: Dict) -> List[Dict]:
        return [rule for rule in self.rules if self._evaluate_condition(rule["condition"], settings)]

    def _resolve_violation(self, settings: Dict, violation: Dict) -> Dict:
        target = violation.get("reroll_target")
        if target in self.parameters:
            values = self.parameters[target].get("values", [])
            for val in values:
                test = dict(settings)
                test[target] = val
                if not self._check_hard_constraints(test):
                    settings[target] = val
                    return settings
            settings[target] = values[0] if values else ""
        return settings

    def compose_description(self, settings: Dict[str, str]) -> str:
        parts = []
        for k in BG_KEYS:
            val = settings.get(k, "")
            if val and val.lower() not in ("", "random", "empty"):
                label = self.parameters.get(k, {}).get("labels", {}).get(val, val.replace("_", " "))
                if label:
                    parts.append(label.strip())
        if not parts:
            return ""
        description = " ".join(parts).strip().replace("..", ".").replace("  ", " ")
        return description if description.endswith(".") else description + "."


# ---------------------------------------------------------------- action
class ActionEngine(_Rules):
    def __init__(self, spec: Dict[str, Any], rng):
        self.spec = spec or {}
        self.rng = rng
        self.parameters = self.spec.get("parameters", {})
        self.rules = self.spec.get("hard_forbidden_combinations", [])

    def _pick(self, param):
        values = self.parameters.get(param, {}).get("values", [])
        return self.rng.choice(values) if values else ""

    def generate_action(self, fixed_settings: Optional[Dict[str, str]] = None, external_settings: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        fixed_settings = fixed_settings or {}
        external_settings = external_settings or {}
        settings = fixed_settings.copy()
        for param in ACT_KEYS:
            if param not in settings:
                settings[param] = self._pick(param)
        for _ in range(50):
            # the camera (framing, viewpoint, ratio) and the subjects take part in the rules ("spatial awareness")
            violations = self._check_hard_constraints({**external_settings, **settings})
            if not violations:
                break
            for violation in violations:
                target = violation.get("reroll_target")
                if target and target in self.parameters and target not in fixed_settings:
                    settings = self._resolve_violation(settings, external_settings, violation)
                else:
                    for k in ACT_KEYS:
                        if k not in fixed_settings:
                            settings[k] = self._pick(k)
        return settings

    def _check_hard_constraints(self, context: Dict) -> List[Dict]:
        violations = []
        for rule in self.rules:
            # actions.json keeps its rules as plain strings: no target = reroll everything that is free
            if isinstance(rule, str):
                cond, rule_dict = rule, {"condition": rule, "reroll_target": ""}
            elif isinstance(rule, dict):
                cond, rule_dict = rule.get("condition", ""), rule
            else:
                continue
            if cond and self._evaluate_condition(cond, context):
                violations.append(rule_dict)
        return violations

    def _resolve_violation(self, settings: Dict, external_settings: Dict, violation: Dict) -> Dict:
        target = violation.get("reroll_target")
        if target in self.parameters:
            values = self.parameters[target].get("values", [])
            for val in values:
                test = {**external_settings, **settings}
                test[target] = val
                if not self._check_hard_constraints(test):
                    settings[target] = val
                    return settings
            settings[target] = values[0] if values else ""
        return settings

    def compose_description(self, settings: Dict[str, str]) -> str:
        parts = []
        for k in ACT_KEYS:
            val = settings.get(k, "")
            if val and val.lower() not in ("", "none", "random", "empty"):
                label = self.parameters.get(k, {}).get("labels", {}).get(val, val.replace("_", " "))
                if label:
                    parts.append(label.strip())
        if not parts:
            return ""
        description = ("ACTION DIRECTIVE: " + " ".join(parts).strip()).replace("..", ".").replace("  ", " ")
        return description if description.endswith(".") else description + "."


# ---------------------------------------------------------------- visual engine
class VisualEngine:
    def __init__(self, spec: Dict[str, Any], rng=None):
        self.rng = rng
        ve = (spec or {}).get("visual_engine", {})
        self.library = ve.get("library", {})
        self.choices = ve.get("choices", [])

    def get_catalog(self):
        out = []
        for code in self.choices:
            d = self.library.get(code, {})
            out.append({"code": code, "category": d.get("category", ""), "engine": d.get("engine", ""), "variant": d.get("variants", [])})
        return out

    def block_text(self, code: str, variant: str) -> str:
        """The text V6 writes into the VE box: medium, camera rules, texture (non-empty ones) + the variant, blank lines between."""
        block = self.library.get(code, {})
        parts = [str(block.get(k, "")) for k in ("core_visual_medium", "technical_camera_rules", "texture_render_quality") if block.get(k)]
        if variant and variant.strip().lower() not in ("", "random", "variant..."):
            parts.append(variant)
        return "\n\n".join(parts)


# ---------------------------------------------------------------- human body
class HumanBodyGenerator:
    def __init__(self, spec: Dict[str, Any], rng):
        self.spec = spec or {}
        self.rng = rng
        self.parameters = self.spec.get("parameters", {})
        self.compatibility = self.spec.get("compatibility_matrix", {})
        self.forbidden = self.spec.get("hard_forbidden_combinations", [])

    def generate_random_body(self, sex: Optional[str] = None) -> Dict[str, Any]:
        if sex is None:
            sex = self.rng.choice(["male", "female"])
        body = {"sex": sex}
        body.update(self._generate_base_parameters(sex))
        body.update(self._generate_derived_parameters(body))
        for attempt in range(50):
            violations = self._check_hard_constraints(body)
            if not violations:
                break
            for violation in violations:
                body = self._resolve_violation(body, violation)
            if attempt == 49:
                body = {"sex": sex}
                body.update(self._generate_base_parameters(sex))
        return body

    def _generate_base_parameters(self, sex: str) -> Dict[str, Any]:
        params = {}
        for name, data in self.parameters.items():
            if name == "sex":
                continue
            if "sex_restriction" in data and data["sex_restriction"] != sex and data["sex_restriction"] != f"{sex}_only":
                continue
            if "values" in data:
                if "values_by_sex" in data:
                    values = data["values_by_sex"].get(sex, []) or data.get("default_values", ["default"])
                else:
                    values = data["values"]
                if name in self.compatibility:
                    params[name] = self._weighted_choice_with_compatibility(values, name, params)
                else:
                    params[name] = self.rng.choice(values) if values else ""
            elif "min" in data and "max" in data:
                if data.get("distribution") == "gaussian":
                    mean = data.get("mean", (data["min"] + data["max"]) / 2)
                    std = data.get("std", (data["max"] - data["min"]) / 6)
                    value = max(data["min"], min(data["max"], self.rng.gauss(mean, std)))
                else:
                    value = self.rng.uniform(data["min"], data["max"])
                params[name] = round(value, 1)
        return params

    def _weighted_choice_with_compatibility(self, values: List[str], param_name: str, current: Dict) -> str:
        if param_name not in self.compatibility:
            return self.rng.choice(values)
        compat = self.compatibility[param_name]
        weights = []
        for value in values:
            w = 1.0
            if value in compat:
                for other, info in compat[value].items():
                    if other in current:
                        cur = current[other]
                        if isinstance(info, dict) and cur in info:
                            w *= info[cur]
                        elif isinstance(info, (int, float)):
                            w *= info
            weights.append(w)
        total = sum(weights)
        if total <= 0:
            return self.rng.choice(values)
        r, cum = self.rng.random() * total, 0
        for value, w in zip(values, weights):
            cum += w
            if r <= cum:
                return value
        return values[-1]

    def _check_hard_constraints(self, body: Dict) -> List[Dict]:
        out = []
        for rule in self.forbidden:
            try:
                if self._evaluate_condition(rule["condition"], body):
                    out.append(rule)
            except Exception:                      # V6: a rule that can't be read is skipped
                continue
        return out

    def _evaluate_condition(self, condition: str, body: Dict) -> bool:
        if " AND " in condition:
            return all(self._evaluate_condition(p.strip(), body) for p in condition.split(" AND "))
        m = re.match(r"(\w+)\s+NOT\s+IN\s+\[(.*?)\]", condition)
        if m:
            if m.group(1) not in body:             # V6: a parameter the body hasn't got = the rule doesn't apply
                return False
            return body.get(m.group(1)) not in _list_of(m.group(2))
        m = re.match(r"(\w+)\s+IN\s+\[(.*?)\]", condition)
        if m:
            return body.get(m.group(1)) in _list_of(m.group(2))
        if "==" in condition:
            left, right = condition.split("==")
            left, right = left.strip(), right.strip().strip("'\"")
            if "." in right:
                right = self._resolve_path(right, body)
            if right.isdigit():
                right = float(right) if "." in right else int(right)
            elif right.lower() in ("true", "false"):
                right = right.lower() == "true"
            return body.get(left) == right
        if ">" in condition:
            left, right = condition.split(">")
            left, right = left.strip(), right.strip()
            if right.isdigit():
                right = float(right)
            elif "." in right:
                right = self._resolve_path(right, body)
            return float(body.get(left, 0)) > float(right)
        if "<" in condition:
            left, right = condition.split("<")
            left, right = left.strip(), right.strip()
            if right.isdigit():
                right = float(right)
            return float(body.get(left, 0)) < float(right)
        return False

    def _resolve_path(self, path: str, body: Dict) -> Any:
        cur = body
        for part in path.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                return None
        return cur

    def _resolve_violation(self, body: Dict, violation: Dict) -> Dict:
        action = violation.get("action", "reroll")
        if action == "suppress" and "targets" in violation:
            for target in violation["targets"]:
                if target.endswith("*"):
                    for k in [k for k in body if k.startswith(target[:-1])]:
                        body[k] = ""
                elif target in body:
                    body[target] = ""
        elif action == "force_value" and "force" in violation:
            for k, v in violation["force"].items():
                body[k] = v
        elif action == "reroll" and "reroll_target" in violation:
            t = violation["reroll_target"]
            if t in self.parameters:
                body[t] = self._generate_parameter_value(t, body.get("sex"))
        elif action == "reroll_with_penalty" and "reroll_target" in violation:
            t = violation["reroll_target"]
            if t in self.parameters:
                values = self.parameters[t].get("values", [])
                if values:
                    body[t] = self.rng.choice(values)
        return body

    def _generate_parameter_value(self, name: str, sex: str) -> Any:
        if name not in self.parameters:
            return None
        data = self.parameters[name]
        if "values" in data:
            values = data["values_by_sex"][sex] if "values_by_sex" in data and sex in data["values_by_sex"] else data["values"]
            return self.rng.choice(values) if values else ""
        if "min" in data and "max" in data:
            return round(self.rng.uniform(data["min"], data["max"]), 1)
        return None

    def _generate_derived_parameters(self, body: Dict) -> Dict:
        derived = {}
        hp = self.parameters.get("height_cm", {})
        if "gaussian_by_sex" in hp:
            heights = {"male": {"mean": 175, "std": 7}, "female": {"mean": 162, "std": 6}}
            sex = body.get("sex", "male")
            if sex in heights:
                h = heights[sex]
                derived["height_cm"] = round(max(150, min(200, self.rng.gauss(h["mean"], h["std"]))), 1)
        if "weight_kg" in self.parameters.get("derived_parameters", {}):
            bmi = max(15, min(40, 18 + (body.get("body_fat_percentage", 20) / 3)))
            derived["weight_kg"] = round(bmi * (body.get("height_cm", 170) / 100) ** 2, 1)
            derived["bmi"] = round(bmi, 1)
        return derived

    def format_body(self, body: Dict) -> str:
        final = {"global": [], "face": [], "torso": [], "legs": []}
        view_cats = self.spec.get("view_categories", {})

        def get_label(p, v):
            if not v:
                return ""
            return self.parameters.get(p, {}).get("labels", {}).get(v, str(v).replace("_", " "))

        def process_val(k, v):
            if isinstance(v, list):
                return " and ".join(get_label(k, i) for i in v)
            if isinstance(v, bool):
                return k.replace("_", " ") if v else ""
            return get_label(k, v)

        sex = body.get("sex", "person")
        sex_label = "man" if sex == "male" else "woman" if sex == "female" else "person"
        age_str = f"{int(body['age'])}-year-old" if "age" in body else ""
        identity = " ".join(filter(bool, [age_str, get_label("ethnicity", body.get("ethnicity")), sex_label]))
        if identity:
            final["global"].append(identity)
        skip = {"sex", "age", "ethnicity", "bmi", "weight_kg", "height_cm"}
        for key, value in body.items():
            if key in skip or not value:
                continue
            s = process_val(key, value)
            if not s:
                continue
            cat = "global"
            for c, keys in view_cats.items():
                if key in keys:
                    cat = c
                    break
            final.setdefault(cat, []).append(s)
        return "\n\n".join(", ".join(final[k]) for k in ("global", "face", "torso", "legs") if final.get(k))


# ---------------------------------------------------------------- clothes
class ClothesEngine:
    def __init__(self, spec: Dict[str, Any], rng):
        self.spec = spec or {}
        self.rng = rng

    def generate_outfit(self, sex: str = "random") -> str:
        if sex == "random":
            sex = self.rng.choice(["male", "female", "trans"])
        groups = {"global": [], "torso": [], "legs": []}
        view_cats = self.spec.get("view_categories", {})
        for name, data in self.spec.items():
            if name in ("hard_forbidden_combinations", "view_categories") or not isinstance(data, dict):
                continue
            items = []
            if sex == "male":
                items += data.get("male", [])
            elif sex == "female":
                items += data.get("female", [])
            elif sex == "trans":
                items += data.get("male", []) + data.get("female", [])
            if items:
                item = self.rng.choice(items)
                cat = "global"
                for c, lst in view_cats.items():
                    if name in lst:
                        cat = c
                        break
                if cat == "face":
                    cat = "torso"
                if cat in groups:
                    groups[cat].append(item)
        return "\n\n".join(", ".join(groups[k]).capitalize() for k in ("global", "torso", "legs") if groups[k])

    def check_compatibility(self, outfit_text: str, target_sex: str) -> bool:
        if not outfit_text or outfit_text == "A standard generic outfit":
            return False
        # FIX D-365: V6 answered False for "random", so a random-sex body re-rolled its outfit at every notecard change
        if target_sex in ("trans", "random"):
            return True
        low = outfit_text.lower()
        male, female = [], []
        for name, data in self.spec.items():
            if isinstance(data, dict) and name != "hard_forbidden_combinations":
                male += [i.lower() for i in data.get("male", [])]
                female += [i.lower() for i in data.get("female", [])]
        if target_sex == "female":
            return not any(m in low and m not in female for m in male)
        if target_sex == "male":
            return not any(f in low and f not in male for f in female)
        return False
