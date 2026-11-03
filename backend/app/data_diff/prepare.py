"""Everything a model's diff needs before any rows are compared: both relations, both schemas,
the key and the strategy (joined vs separate).

Strategy per model (the decision is per model, not per target — access can differ by schema):

1. Both targets' connection identity (connection_info.py). Different instance → separate.
2. Same relation name on both targets: on the same instance it's literally the same table
   (refused); otherwise only separate makes sense.
3. Otherwise a zero-row `select * from <prod relation> where 1 = 0` on the dev connection, for
   every candidate in one `dbt show`: it works → joined (wickd_pro still checks the prod row count
   on both connections and falls back to separate if they disagree); it fails → separate, and why.
"""

from dataclasses import dataclass, field
from typing import Any

from app.data_diff.keys import Key, grain_of, resolve_key
from app.dbt.connection_info import TargetConnection, same_instance
from app.dbt.probe import ProbeResult

Runner = Any  # async (side, sqls) -> [result dict]


@dataclass
class ModelPlan:
    unique_id: str
    name: str
    materialization: str | None = None
    dev_relation: str | None = None
    prod_relation: str | None = None
    dev_columns: list[list[str]] = field(default_factory=list)
    prod_columns: list[list[str]] = field(default_factory=list)
    key: Key | None = None
    mode: str | None = None
    columns: list[str] | None = None
    where: str | None = None
    notes: list[str] = field(default_factory=list)
    error: dict[str, str] | None = None

    def fail(self, code: str, message: str) -> None:
        if self.error is None:
            self.error = {"code": code, "message": message}

    def spec(self, adapter_type: str | None, tolerance: float) -> dict[str, Any]:
        return {
            "adapter_type": adapter_type, "mode": self.mode, "dev_relation": self.dev_relation,
            "prod_relation": self.prod_relation, "dev_columns": self.dev_columns, "prod_columns": self.prod_columns,
            "key": list(self.key.columns) if self.key else [], "columns": self.columns, "where": self.where,
            "tolerance": tolerance,
        }


def new_plans(manifest: dict, unique_ids: list[str]) -> list[ModelPlan]:
    nodes = manifest.get("nodes") or {}
    plans = []
    for uid in unique_ids:
        node = nodes.get(uid) or {}
        plan = ModelPlan(uid, str(node.get("name") or uid.split(".")[-1]),
                         materialization=(node.get("config") or {}).get("materialized"))
        if node.get("resource_type") not in ("model", "seed", "snapshot"):
            plan.fail("not_a_model", "Only models, seeds and snapshots can be diffed.")
        elif plan.materialization == "ephemeral":
            plan.fail("ephemeral", "Ephemeral models aren't built, so there's nothing to compare.")
        plans.append(plan)
    return plans


def _columns(probe: ProbeResult | None) -> list[list[str]]:
    if probe is None:
        return []
    types = list(probe.types) or [""] * len(probe.columns)
    return [[c, t] for c, t in zip(probe.columns, types, strict=False)]


def apply_relations(plans: list[ModelPlan], dev: dict[str, str | None], prod: dict[str, str | None], prod_target: str) -> None:
    for p in plans:
        p.dev_relation, p.prod_relation = dev.get(p.unique_id), prod.get(p.unique_id)
        if not p.dev_relation:
            p.fail("no_relation", "This model has no relation in the current manifest. Build or parse it first.")
        elif not p.prod_relation:
            p.fail("no_relation", f"This model has no relation on the `{prod_target}` target.")


def apply_columns(plans: list[ModelPlan], dev: dict[str, ProbeResult] | None, prod: dict[str, ProbeResult] | None,
                  dev_target: str, prod_target: str) -> None:
    for p in plans:
        if p.error:
            continue
        d, r = (dev or {}).get(p.name), (prod or {}).get(p.name)
        if dev is None or prod is None:
            p.fail("probe_failed", f"Couldn't read the columns of {'dev' if dev is None else 'prod'} from the warehouse.")
        elif d is None or d.not_built:
            p.fail("dev_missing", f"`{p.name}` isn't built on `{dev_target}` yet. Build it in dev, then diff.")
        elif r is None or r.not_built:
            p.fail("prod_missing", f"`{p.name}` doesn't exist on `{prod_target}` yet, so every row is new.")
        elif d.error or r.error:
            p.fail("probe_failed", d.error or r.error or "Couldn't read the columns.")
        else:
            p.dev_columns, p.prod_columns = _columns(d), _columns(r)


def apply_keys(plans: list[ModelPlan], manifest: dict, structure: dict, user_keys: dict[str, list[str]]) -> None:
    for p in plans:
        if p.error:
            continue
        prod_lower = {c.lower() for c, _ in p.prod_columns}
        shared = {c for c, _ in p.dev_columns if c.lower() in prod_lower}
        p.key = resolve_key(manifest, p.unique_id, available=shared, grain=grain_of(structure, p.unique_id),
                            user=user_keys.get(p.unique_id))
        if user_keys.get(p.unique_id) and (p.key is None or p.key.source != "user"):
            p.notes.append("The key you picked isn't a column on both sides, so another was used.")


def _instance_note(dev: TargetConnection, prod: TargetConnection) -> str:
    differs = sorted(k for k in set(dev.instance) | set(prod.instance)
                     if dev.instance.get(k, "").lower() != prod.instance.get(k, "").lower())
    what = ", ".join(f"`{k}`" for k in differs) or "the connection"
    return f"`{dev.target}` and `{prod.target}` connect to different warehouses ({what} differs), so each side was read on its own connection."


def access_probe_sql(prod_relation: str) -> str:
    return f"select * from {prod_relation} where 1 = 0"


async def choose_modes(plans: list[ModelPlan], dev: TargetConnection, prod: TargetConnection,
                       run: Runner, forced: str) -> None:
    live = [p for p in plans if not p.error]
    if forced == "separate":
        for p in live:
            p.mode = "separate"
            p.notes.append("Compared across connections, as asked.")
        return
    same = same_instance(dev, prod)
    probe: list[ModelPlan] = []
    for p in live:
        if same is False:
            p.mode = "separate"
            p.notes.append(_instance_note(dev, prod))
        elif p.dev_relation == p.prod_relation:
            if same:
                p.fail("same_relation", f"Dev and prod both resolve to {p.dev_relation}; check your targets' schemas.")
            else:
                p.mode = "separate"
                p.notes.append("Dev and prod use the same relation name, so each side was read on its own connection.")
        else:
            probe.append(p)
    if not probe:
        return
    results = await run("dev", [access_probe_sql(p.prod_relation or "") for p in probe])
    for p, res in zip(probe, results, strict=True):
        if res.get("error"):
            p.mode = "separate"
            reason = str(res["error"]).strip().splitlines()[-1][:200] if str(res["error"]).strip() else "it failed"
            p.notes.append(f"`{dev.target}` can't read {p.prod_relation} ({reason}), so each side was read on its own connection.")
        else:
            p.mode = "joined"
            p.notes.append(f"Compared in the warehouse: `{dev.target}` reads {p.prod_relation} directly.")


def incremental_note(plan: ModelPlan) -> None:
    if plan.materialization == "incremental" and not plan.where:
        plan.notes.append("This model is incremental: dev may hold a different history than prod. Add a filter to "
                          "compare a recent window, or full-refresh both.")
