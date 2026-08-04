#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: with-apt-ubuntu-sources.sh command [arg ...]" >&2
  exit 2
fi

if [ "${RUNNER_OS:-Linux}" != "Linux" ] || [ ! -d /etc/apt ]; then
  exec "$@"
fi

if command -v sudo >/dev/null 2>&1; then
  run_privileged() { sudo "$@"; }
elif [ "$(id -u)" -eq 0 ]; then
  run_privileged() { "$@"; }
else
  echo "[apt-sources] error: Linux apt isolation requires sudo or a root runner" >&2
  exit 1
fi

workspace_temp="${RUNNER_TEMP:-/tmp}"
isolation_dir="$workspace_temp/forgeax-apt-isolation-$$"
apt_config="$isolation_dir/apt.conf"
source_list="$isolation_dir/sources.list"
source_parts="$isolation_dir/sources.list.d"
mkdir -p "$isolation_dir"
run_privileged mkdir -p "$source_parts"

cleanup() {
  set +e
  run_privileged rm -f "/etc/apt/apt.conf.d/99forgeax-isolation-$$"
  run_privileged rm -rf "$isolation_dir"
}
trap cleanup EXIT INT TERM

projected_sources=0
while IFS= read -r -d '' source_file; do
  source_name="$(basename "$source_file")"
  if [[ "$source_name" =~ (kubernetes|k8s) ]] \
    || run_privileged grep -Eiq 'kubernetes|k8s|packages\.k8s\.io|apt\.kubernetes\.io|prod-cdn\.packages' "$source_file"; then
    echo "[apt-sources] excluded $source_file"
    continue
  fi
  case "$source_file" in
    /etc/apt/sources.list)
      run_privileged cp -L "$source_file" "$source_list"
      ;;
    /etc/apt/sources.list.d/*)
      run_privileged cp -L "$source_file" "$source_parts/$(basename "$source_file")"
      ;;
    *)
      continue
      ;;
  esac
  projected_sources=$((projected_sources + 1))
  echo "[apt-sources] projected $source_file"
done < <(run_privileged find /etc/apt -maxdepth 3 \( -type f -o -type l \) \( -name '*.list' -o -name '*.sources' \) -print0)

{
  printf 'Dir::Etc::sourcelist "%s";\n' "$source_list"
  printf 'Dir::Etc::sourceparts "%s";\n' "$source_parts"
  printf '%s\n' 'Acquire::Retries "3";'
  printf '%s\n' 'Acquire::http::Timeout "30";'
  printf '%s\n' 'Acquire::https::Timeout "30";'
} > "$apt_config"
run_privileged install -m 0644 "$apt_config" "/etc/apt/apt.conf.d/99forgeax-isolation-$$"
echo "[apt-sources] isolated source projection active (${projected_sources} file(s)) for: $*"

"$@"
