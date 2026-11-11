"""packaging/check_pro_native.py: shipped builds refuse a pure-Python wickd_pro."""

import importlib.machinery
import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).parents[1] / "packaging" / "check_pro_native.py"
_spec = importlib.util.spec_from_file_location("check_pro_native", _SCRIPT)
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

EXT = importlib.machinery.EXTENSION_SUFFIXES[0]


def _touch(root: Path, *names: str) -> Path:
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
    return root


def test_native_build_passes(tmp_path: Path) -> None:
    pkg = _touch(tmp_path, f"__init__{EXT}", f"column_lineage{EXT}", f"ai/__init__{EXT}", "_bundle_imports.py")
    assert check.problems(pkg) == []


def test_pure_python_build_fails(tmp_path: Path) -> None:
    pkg = _touch(tmp_path, "__init__.py", "column_lineage.py")
    issues = check.problems(pkg)
    assert "Python source shipped: column_lineage.py" in issues
    assert "no compiled extension modules found" in issues
    assert "wickd_pro/__init__ is not compiled" in issues


def test_stray_source_next_to_compiled_modules_fails(tmp_path: Path) -> None:
    pkg = _touch(tmp_path, f"__init__{EXT}", f"structure{EXT}", "ai/prompts.py")
    assert check.problems(pkg) == ["Python source shipped: ai/prompts.py"]


def test_bundle_imports_allowed_only_at_package_root(tmp_path: Path) -> None:
    pkg = _touch(tmp_path, f"__init__{EXT}", "ai/_bundle_imports.py")
    assert check.problems(pkg) == ["Python source shipped: ai/_bundle_imports.py"]
