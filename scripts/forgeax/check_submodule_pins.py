#!/usr/bin/env python3
"""check_submodule_pins.py - verify every git submodule pin is on the submodule's main.

Why this gate exists:
  A superrepo commit can pin a submodule commit that only lives on a submodule
  FEATURE branch (never merged into the submodule's main). When such a pin lands
  on the superrepo's main, a fresh `git submodule update --init` may still work
  (the object is fetchable while the feature branch exists) but the pin is not
  durable: once the submodule feature branch is deleted, the pin becomes
  unreachable. This is exactly what happened when forgeax-engine PR #568 merged
  before its paired forgeax-engine-assets PR #10.

  The rule enforced here: for every submodule declared in .gitmodules, the pinned
  commit (the gitlink SHA in HEAD) MUST be an ancestor of (or equal to) that
  submodule's `origin/main`. Merge the submodule's PR first, THEN pin the
  superrepo to the resulting main commit.

Check per submodule:
  git -C <submodule> fetch origin main        # refresh origin/main tip
  git -C <submodule> merge-base --is-ancestor <pin> <main-ref>

  <main-ref> is `origin/main` when present (the CI case: submodule checked out in
  detached HEAD), else the local `main` branch. A submodule with neither is a
  distinct failure (cannot verify), not a silent pass.

Exit codes:
  0  all submodule pins are on their submodule main (or repo has no submodules)
  1  at least one pin is not on its submodule main (or cannot be verified)
  2  CLI / IO error

Usage:
  python check_submodule_pins.py                 # check the current repo (cwd)
  python check_submodule_pins.py --repo <path>   # check an explicit superrepo worktree
  python check_submodule_pins.py --self-test     # run built-in fixtures, no repo needed
"""
import argparse
import subprocess
import sys
from pathlib import Path


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _list_submodule_paths(repo: Path) -> list[str]:
    """Paths declared in .gitmodules (config-file read; no network)."""
    gitmodules = repo / ".gitmodules"
    if not gitmodules.exists():
        return []
    res = _git(
        repo,
        "config",
        "--file",
        str(gitmodules),
        "--get-regexp",
        r"^submodule\..*\.path$",
    )
    if res.returncode != 0:
        return []
    paths: list[str] = []
    for line in res.stdout.splitlines():
        # "submodule.<name>.path <value>"
        parts = line.split(None, 1)
        if len(parts) == 2:
            paths.append(parts[1].strip())
    return paths


def _pin_sha(repo: Path, sub_path: str) -> str | None:
    """The gitlink SHA recorded in HEAD for sub_path (the pin)."""
    res = _git(repo, "ls-tree", "HEAD", sub_path)
    if res.returncode != 0:
        return None
    # "<mode> commit <sha>\t<path>"
    parts = res.stdout.split()
    if len(parts) >= 3 and parts[1] == "commit":
        return parts[2]
    return None


def _resolve_main_ref(sub_repo: Path) -> str | None:
    """Pick the ref for the submodule's main line: origin/main preferred, else main.

    origin/main is preferred over a local `main` branch because in CI (and any
    fresh checkout) the submodule sits in detached HEAD and any local `main` is
    absent or stale; the just-fetched origin/main is the remote source of truth.
    """
    # `git fetch origin main` updates FETCH_HEAD only; it intentionally does
    # not guarantee that refs/remotes/origin/main moves. That distinction is
    # observable in CI's detached, shallow submodule checkouts: the subsequent
    # ancestry check can inspect a stale origin/main and reject a pin which has
    # already landed on the remote main branch. Update the exact ref we inspect.
    _git(
        sub_repo,
        "fetch",
        "--quiet",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
    )
    if _git(sub_repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main").returncode == 0:
        return "origin/main"
    if _git(sub_repo, "rev-parse", "--verify", "--quiet", "refs/heads/main").returncode == 0:
        return "main"
    return None


def _is_ancestor(sub_repo: Path, pin: str, main_ref: str) -> bool:
    return _git(sub_repo, "merge-base", "--is-ancestor", pin, main_ref).returncode == 0


def check_repo(repo: Path) -> tuple[int, list[tuple[str, str, str]]]:
    """Return (exit_code, findings). findings: (sub_path, pin, reason)."""
    sub_paths = _list_submodule_paths(repo)
    if not sub_paths:
        return 0, []

    findings: list[tuple[str, str, str]] = []
    for sub_path in sub_paths:
        pin = _pin_sha(repo, sub_path)
        if pin is None:
            # Declared in .gitmodules but not a gitlink in HEAD — nothing to verify.
            continue
        sub_repo = (repo / sub_path).resolve()
        if not (sub_repo / ".git").exists():
            findings.append((
                sub_path,
                pin,
                f"submodule worktree not initialized — run "
                f"`git submodule update --init {sub_path}` then re-check",
            ))
            continue
        main_ref = _resolve_main_ref(sub_repo)
        if main_ref is None:
            findings.append((
                sub_path,
                pin,
                "no origin/main or local main in submodule — cannot verify pin",
            ))
            continue
        if not _is_ancestor(sub_repo, pin, main_ref):
            findings.append((
                sub_path,
                pin,
                f"pin {pin[:12]} not on {main_ref} — submodule feature branch not "
                "merged into submodule main. Merge the submodule PR first, then "
                "re-pin the superrepo to the resulting main commit.",
            ))
    return (1 if findings else 0), findings


def _print_findings(repo: Path, findings: list[tuple[str, str, str]]) -> None:
    print("[BLOCKED] a submodule pin is not on its submodule main.", file=sys.stderr)
    print(f"  superrepo: {repo}", file=sys.stderr)
    print("  Fix: merge each submodule's PR into that submodule's main FIRST,", file=sys.stderr)
    print("  then bump the superrepo pin to the resulting main commit.", file=sys.stderr)
    print("", file=sys.stderr)
    for sub_path, pin, reason in findings:
        print(f"  - {sub_path}", file=sys.stderr)
        print(f"      pin:    {pin}", file=sys.stderr)
        print(f"      reason: {reason}", file=sys.stderr)


def _self_test() -> int:
    """Fixture-based check of the ancestry logic using throwaway git repos.

    Builds a submodule-like repo with a main branch and a feature branch, then
    asserts _is_ancestor is True for a main commit and False for a feature-only
    commit. No network, no real submodules.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        sub = Path(td) / "sub"
        sub.mkdir()
        env_cfg = [
            ("init", "-q", "-b", "main"),
            ("config", "user.email", "t@t"),
            ("config", "user.name", "t"),
        ]
        for args in env_cfg:
            if _git(sub, *args).returncode != 0:
                print("self-test setup failed", file=sys.stderr)
                return 2
        (sub / "f").write_text("1\n")
        _git(sub, "add", "f")
        _git(sub, "commit", "-q", "-m", "c1")
        main_commit = _git(sub, "rev-parse", "HEAD").stdout.strip()
        _git(sub, "checkout", "-q", "-b", "feat")
        (sub / "f").write_text("2\n")
        _git(sub, "add", "f")
        _git(sub, "commit", "-q", "-m", "c2")
        feat_commit = _git(sub, "rev-parse", "HEAD").stdout.strip()

        ok = True
        if not _is_ancestor(sub, main_commit, "main"):
            print("self-test FAIL: main commit should be ancestor of main", file=sys.stderr)
            ok = False
        if _is_ancestor(sub, feat_commit, "main"):
            print("self-test FAIL: feature-only commit should NOT be on main", file=sys.stderr)
            ok = False
        if ok:
            print("self-test OK")
            return 0
        return 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--repo", type=Path, default=None,
                    help="superrepo worktree to check (default: current directory)")
    ap.add_argument("--self-test", action="store_true",
                    help="run built-in fixtures and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return _self_test()

    repo = (args.repo or Path.cwd()).resolve()
    if not (repo / ".git").exists():
        print(f"[error] not a git repo: {repo}", file=sys.stderr)
        return 2

    code, findings = check_repo(repo)
    if code == 0:
        print("[OK] all submodule pins are on their submodule main (or no submodules)")
    else:
        _print_findings(repo, findings)
    return code


if __name__ == "__main__":
    sys.exit(main())
