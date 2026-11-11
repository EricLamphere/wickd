"""Fail unless the installed wickd_pro is the native (Cython) build.

Run by `task _package:pro-check` before every pro build: shipped builds must
carry wickd_pro as compiled extension modules, never as Python source or
bytecode. The one allowed source file is `_bundle_imports.py`, a generated list
of import statements for PyInstaller (see wickd-pro's setup.py).

Exit codes: 0 native, 1 not installed / not native.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import sys
from pathlib import Path

ALLOWED_SOURCES = frozenset({"_bundle_imports.py"})


def problems(package_dir: Path) -> list[str]:
    """Why `package_dir` isn't a native wickd_pro build (empty = it is)."""
    suffixes = tuple(importlib.machinery.EXTENSION_SUFFIXES)
    sources = [
        p for p in package_dir.rglob("*.py") if p.relative_to(package_dir).as_posix() not in ALLOWED_SOURCES
    ]
    found = [str(p.relative_to(package_dir)) for p in sources]
    issues = [f"Python source shipped: {name}" for name in sorted(found)]
    if not any(p.name.endswith(suffixes) for p in package_dir.rglob("*")):
        issues.append("no compiled extension modules found")
    if not any(p.name.startswith("__init__.") and p.name.endswith(suffixes) for p in package_dir.iterdir()):
        issues.append("wickd_pro/__init__ is not compiled")
    return issues


def main() -> int:
    spec = importlib.util.find_spec("wickd_pro")
    if spec is None or not spec.submodule_search_locations:
        print("wickd_pro is not installed in this venv — run 'task package:pro' first.")
        return 1
    package_dir = Path(next(iter(spec.submodule_search_locations)))
    issues = problems(package_dir)
    if issues:
        print(f"wickd_pro at {package_dir} is not a native build — rerun 'task package:pro':")
        for issue in issues:
            print(f"  - {issue}")
        return 1
    print(f"wickd_pro is native ({package_dir}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
