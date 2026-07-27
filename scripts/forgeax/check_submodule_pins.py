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

  CI requires a successful fetch and uses the resulting `origin/main` ref. A
  shallow submodule is unshallowed before the fetch so ancestry is complete. A
  submodule with no remote main is a distinct failure (cannot verify), not a
  silent pass.

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


def _git_detail(res: subprocess.CompletedProcess) -> str:
    detail = (res.stderr or res.stdout).strip()
    return detail or f"git exited with code {res.returncode}"


def _resolve_main_ref(sub_repo: Path) -> tuple[str | None, str | None]:
    """Refresh and resolve the submodule's remote main ref.

    The submodule checkout is detached in CI and may be shallow. Never fall
    back to a stale local ref when refreshing the remote fails: that turns a
    transport or cache problem into a misleading ancestry verdict.
    """
    shallow = _git(sub_repo, "rev-parse", "--is-shallow-repository")
    if shallow.returncode != 0:
        return None, f"could not inspect repository depth: {_git_detail(shallow)}"

    fetch_args = [
        "fetch",
        "--quiet",
    ]
    if shallow.stdout.strip() == "true":
        fetch_args.append("--unshallow")
    fetch_args.extend([
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
    ])
    fetched = _git(sub_repo, *fetch_args)
    if fetched.returncode != 0:
        return None, f"failed to refresh origin/main: {_git_detail(fetched)}"

    main_ref = _git(
        sub_repo,
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/remotes/origin/main",
    )
    if main_ref.returncode != 0:
        return None, "origin/main is missing after a successful fetch"
    return "origin/main", None


def _is_ancestor(sub_repo: Path, pin: str, main_ref: str) -> tuple[bool, str | None]:
    result = _git(sub_repo, "merge-base", "--is-ancestor", pin, main_ref)
    if result.returncode == 0:
        return True, None
    if result.returncode == 1:
        return False, None
    return False, f"could not verify ancestry: {_git_detail(result)}"


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
        main_ref, resolve_error = _resolve_main_ref(sub_repo)
        if main_ref is None:
            findings.append((
                sub_path,
                pin,
                f"{resolve_error or 'no origin/main in submodule — cannot verify pin'}",
            ))
            continue
        is_ancestor, ancestry_error = _is_ancestor(sub_repo, pin, main_ref)
        if ancestry_error is not None:
            findings.append((sub_path, pin, ancestry_error))
            continue
        if not is_ancestor:
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


def _run_git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _self_test() -> int:
    """Exercise remote refresh, shallow history, and ancestry failure modes."""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        bare = Path(td) / "remote.git"
        seed = Path(td) / "seed"
        bare.mkdir()
        seed.mkdir()
        env_cfg = [
            ("config", "user.email", "t@t"),
            ("config", "user.name", "t"),
        ]
        if _run_git("init", "-q", "--bare", str(bare)).returncode != 0:
            print("self-test setup failed: bare repo", file=sys.stderr)
            return 2
        if _git(seed, "init", "-q", "-b", "main").returncode != 0:
            print("self-test setup failed: seed repo", file=sys.stderr)
            return 2
        for args in env_cfg:
            if _git(seed, *args).returncode != 0:
                print("self-test setup failed: git config", file=sys.stderr)
                return 2
        (seed / "f").write_text("1\n")
        _git(seed, "add", "f")
        _git(seed, "commit", "-q", "-m", "c1")
        main_commit = _git(seed, "rev-parse", "HEAD").stdout.strip()
        _git(seed, "remote", "add", "origin", str(bare))
        _git(seed, "push", "-q", "origin", "main")
        _git(seed, "checkout", "-q", "-b", "feat")
        (seed / "f").write_text("2\n")
        _git(seed, "add", "f")
        _git(seed, "commit", "-q", "-m", "c2")
        feat_commit = _git(seed, "rev-parse", "HEAD").stdout.strip()
        _git(seed, "push", "-q", "origin", "feat")

        checkout = Path(td) / "checkout"
        clone = _run_git(
            "clone",
            "-q",
            "--depth=1",
            "--branch",
            "feat",
            f"file://{bare}",
            str(checkout),
        )
        if clone.returncode != 0:
            print(f"self-test setup failed: shallow clone: {_git_detail(clone)}", file=sys.stderr)
            return 2

        ok = True
        main_ref, resolve_error = _resolve_main_ref(checkout)
        if resolve_error is not None or main_ref != "origin/main":
            print(f"self-test FAIL: remote refresh: {resolve_error or main_ref}", file=sys.stderr)
            ok = False
        main_is_ancestor, ancestry_error = _is_ancestor(checkout, main_commit, "origin/main")
        if ancestry_error is not None or not main_is_ancestor:
            print(f"self-test FAIL: main ancestry: {ancestry_error or 'not an ancestor'}", file=sys.stderr)
            ok = False
        feature_is_ancestor, ancestry_error = _is_ancestor(checkout, feat_commit, "origin/main")
        if ancestry_error is not None or feature_is_ancestor:
            print("self-test FAIL: feature-only commit should NOT be on main", file=sys.stderr)
            ok = False
        _git(checkout, "remote", "set-url", "origin", str(Path(td) / "missing.git"))
        missing_ref, refresh_error = _resolve_main_ref(checkout)
        if missing_ref is not None or refresh_error is None:
            print("self-test FAIL: fetch failure must not use a stale ref", file=sys.stderr)
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
