#!/bin/sh
# Build honk-core for one OpenWrt architecture. Called from Build/Compile in the
# package Makefile, so every input arrives as an environment variable:
#
#   HONK_SRC            build directory holding the checked out sources
#   HONK_VERSION        package version (0.1.0_beta4)
#   HONK_GIT_TAG        upstream release tag the sources come from
#                       (v0.1.0-beta.4); honk's build script embeds this
#   HONK_ARCH_PACKAGES  arch_packages of the target, e.g. aarch64_cortex-a76
#   OPENWRT_CC          OpenWrt cross gcc (TARGET_CROSS + gcc)
#   OPENWRT_CXX         OpenWrt cross g++
#
# The binary has the full feature set: the crate defaults (clash-api, mimalloc,
# rprx) plus ebpf and native-ui. native-ui embeds the doona dashboard pinned in
# .github/ci/pins.env; ci/fetch-doona.sh downloads that release archive and
# verifies its SHA-256, so the frontend is never compiled here.
#
# Cargo, rustc and rustup have to be on PATH, with the toolchains pinned in
# rust-toolchain.toml and crates/honk-ebpf/rust-toolchain.toml installed, plus
# the prebuilt bpf-linker. The environment is prepared by the workflow.
set -eu

cd "${HONK_SRC:?HONK_SRC is not set}"

version="${HONK_VERSION:?HONK_VERSION is not set}"
tag="${HONK_GIT_TAG:?HONK_GIT_TAG is not set}"
cc="${OPENWRT_CC:?OPENWRT_CC is not set}"
cxx="${OPENWRT_CXX:?OPENWRT_CXX is not set}"

case "${HONK_ARCH_PACKAGES:?HONK_ARCH_PACKAGES is not set}" in
  x86_64)   target=x86_64-unknown-linux-musl ;;
  aarch64*) target=aarch64-unknown-linux-musl ;;
  *)
    echo "honk: unsupported OpenWrt architecture '${HONK_ARCH_PACKAGES}'" >&2
    exit 1
    ;;
esac

# OpenWrt's build system exports flags for autotools style packages; the Rust
# crates and CMake derive their own flags from the compiler wrappers below
unset CFLAGS CPPFLAGS CXXFLAGS LDFLAGS RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

echo "honk: building ${version} from tag ${tag} for ${HONK_ARCH_PACKAGES} (${target})"
echo "honk: C compiler ${cc}"
echo "honk: C++ compiler ${cxx}"

# ---------------------------------------------------------------------------
# 1. Compiler wrappers
#
# CMake injects clang style target flags into boring-sys' compile rules
# (CMAKE_*_COMPILER_TARGET) and GCC rejects them. This is upstream's ci/zigcc
# trick, except that the real compiler is the OpenWrt one: the toolchain
# already targets the right triple, so those flags are simply dropped. The
# Cortex-A53 errata options are kept, GCC understands them.
# ---------------------------------------------------------------------------
BIN_DIR="${HONK_SRC}/.ccwrap"
mkdir -p "${BIN_DIR}"
cat > "${BIN_DIR}/openwrt-cc" <<'WRAPPER'
#!/bin/sh
case "${0##*/}" in
  *cxx*) cc="${OPENWRT_CXX}" ;;
  *)     cc="${OPENWRT_CC}" ;;
esac
if [ -z "${cc}" ]; then
  echo "${0##*/}: OPENWRT_CC / OPENWRT_CXX is not set" >&2
  exit 1
fi
skip_next=0
kept=""
for arg in "$@"; do
  if [ "${skip_next}" = 1 ]; then
    skip_next=0
    continue
  fi
  case "${arg}" in
    --target=*) ;;
    -target|--target) skip_next=1 ;;
    *) kept="${kept}
${arg}" ;;
  esac
done
# The kept args are intentionally re-split, as upstream does: CMake and rustc
# pass them pre-split and none of them contain spaces here.
# shellcheck disable=SC2086
exec "${cc}" $(printf '%s' "${kept}" | tail -n +2)
WRAPPER
chmod +x "${BIN_DIR}/openwrt-cc"
ln -sf openwrt-cc "${BIN_DIR}/openwrt-cxx"

target_lower="$(printf '%s' "${target}" | tr '-' '_')"
target_upper="$(printf '%s' "${target}" | tr 'a-z-' 'A-Z_')"

# ---------------------------------------------------------------------------
# 2. bindgen must see the target headers, not the build host's glibc: reuse the
#    include search list of the OpenWrt C++ compiler
# ---------------------------------------------------------------------------
bindgen_args="--target=${target%%-*}-linux-musl"
include_list="$("${cxx}" -E -x c++ -v /dev/null 2>&1 \
  | sed -n '/#include <...> search starts here:/,/End of search list./p' \
  | tail -n +2 | head -n -1 | sed 's/^[[:space:]]*//')"
while IFS= read -r inc; do
  if [ -n "${inc}" ]; then
    bindgen_args="${bindgen_args} -isystem ${inc}"
  fi
done <<EOF
${include_list}
EOF

# ---------------------------------------------------------------------------
# 3. The embedded dashboard (native-ui). build.rs refuses to build without an
#    absolute HONK_DOONA_DIR; ci/fetch-doona.sh downloads the doona release
#    pinned in .github/ci/pins.env, verifies its SHA-256 and prints the
#    extracted directory. The archive ships the built frontend, so nothing is
#    compiled here.
# ---------------------------------------------------------------------------
if [ ! -f "ci/fetch-doona.sh" ]; then
  echo "honk: ci/fetch-doona.sh is missing, native-ui cannot be built" >&2
  exit 1
fi
HONK_DOONA_DIR="$(bash ci/fetch-doona.sh "${HONK_SRC}/.doona")"
export HONK_DOONA_DIR
if [ ! -f "${HONK_DOONA_DIR}/index.html" ]; then
  echo "honk: ${HONK_DOONA_DIR} has no index.html" >&2
  exit 1
fi
echo "honk: embedding the doona UI from ${HONK_DOONA_DIR}"

# ---------------------------------------------------------------------------
# 4. honk-core. The ebpf feature makes build.rs build the eBPF object with the
#    nightly toolchain pinned in crates/honk-ebpf/rust-toolchain.toml and embed
#    both it and the UI. Link against the OpenWrt musl from the SDK sysroot
#    instead of the musl bundled with Rust, so the binary matches the libc of
#    the device. crt-static is turned off as well: the OpenWrt toolchain has no
#    static unwind library (libgcc_eh.a), so a static libstdc++ cannot be used
#    either and everything is linked dynamically.
# ---------------------------------------------------------------------------
echo "honk: building honk-core"
env \
  "CC_${target_lower}=${BIN_DIR}/openwrt-cc" \
  "CXX_${target_lower}=${BIN_DIR}/openwrt-cxx" \
  "CARGO_TARGET_${target_upper}_LINKER=${BIN_DIR}/openwrt-cc" \
  "CARGO_TARGET_${target_upper}_RUSTFLAGS=-C link-self-contained=no -C target-feature=-crt-static" \
  "BINDGEN_EXTRA_CLANG_ARGS=${bindgen_args}" \
  "GITHUB_REF=refs/tags/${tag}" \
  cargo build --release -p honk-core --features ebpf,native-ui --target "${target}"

binary="target/${target}/release/honk-core"
if [ ! -f "${binary}" ]; then
  echo "honk: ${binary} was not produced" >&2
  exit 1
fi

# The version honk's build script picked up is the release tag, not the git
# fallback it uses when GITHUB_REF is not a tag ref. The binary cannot be
# executed here (it is a musl binary for the target), so look for the string.
if ! grep -aq "${tag}" "${binary}"; then
  echo "honk: ${binary} does not embed the expected version ${tag}" >&2
  exit 1
fi
echo "honk: ${binary} embeds version ${tag}"

# native-ui embeds the asset table with its paths, so index.html must be in the
# binary; a build without the feature (or with an empty HONK_DOONA_DIR) has no
# such string and would silently ship without a dashboard.
if ! grep -aq 'index.html' "${binary}"; then
  echo "honk: ${binary} does not contain the embedded doona UI" >&2
  exit 1
fi
echo "honk: ${binary} contains the embedded doona UI"

# OpenWrt runs its own musl, so the binary has to link against exactly that
if readelf -l "${binary}" | grep -q 'program interpreter'; then
  interpreter="$(readelf -l "${binary}" \
    | sed -n 's/.*program interpreter: *\([^]]*\)\].*/\1/p' | head -n1)"
  echo "honk: dynamic loader ${interpreter}"
  case "${interpreter}" in
    /lib/ld-musl-*) ;;
    *)
      echo "honk: ${interpreter} is not the OpenWrt musl loader" >&2
      exit 1
      ;;
  esac
fi

if readelf -d "${binary}" | grep -q NEEDED; then
  readelf -d "${binary}" | grep NEEDED
  if readelf -d "${binary}" | grep -q 'libsystemd'; then
    echo "honk: honk-core links against libsystemd, which OpenWrt does not have" >&2
    exit 1
  fi
  unexpected="$(readelf -d "${binary}" | grep NEEDED \
    | grep -Ev 'libc\.so|libgcc_s\.so|libstdc\+\+\.so' || true)"
  if [ -n "${unexpected}" ]; then
    echo "honk: honk-core needs libraries besides libc and the C++ runtime:" >&2
    echo "${unexpected}" >&2
    exit 1
  fi
  echo "honk: only libc, the C++ runtime and the compiler runtime are needed"
else
  echo "honk: honk-core is statically linked"
fi

# Hand a stable path to the package Makefile
cp "${binary}" "${HONK_SRC}/honk-core"
