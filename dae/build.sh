#!/bin/sh
# Build dae for one OpenWrt architecture. Called from Build/Compile in the
# package Makefile, so every input arrives as an environment variable:
#
#   DAE_SRC            build directory holding the checked out sources
#   DAE_VERSION        version string the binary reports (e.g. 2.1.2)
#   DAE_ARCH_PACKAGES  arch_packages of the target, e.g. aarch64_cortex-a76
#   DAE_CLANG          clang that compiles the bpf2go objects
#   DAE_STRIP          strip program (may be empty)
#
# The build itself is dae's own Makefile: pure Go (CGO_ENABLED=0), so the only
# target specific inputs are GOARCH/GOAMD64/GOARM64.
set -eu

cd "${DAE_SRC:?DAE_SRC is not set}"

case "${DAE_ARCH_PACKAGES:?DAE_ARCH_PACKAGES is not set}" in
  x86_64)
    GOARCH=amd64
    GOAMD64=v1
    expected="x86-64"
    ;;
  aarch64*)
    GOARCH=arm64
    case "${DAE_ARCH_PACKAGES}" in
      # Cortex-A76 implements ARMv8.2 with LSE atomics
      *cortex-a76) GOARM64="v8.2,lse" ;;
      *)           GOARM64="v8.0" ;;
    esac
    expected="ARM aarch64"
    ;;
  *)
    echo "dae: unsupported OpenWrt architecture '${DAE_ARCH_PACKAGES}'" >&2
    exit 1
    ;;
esac

clang="${DAE_CLANG:?DAE_CLANG is not set}"
strip="${DAE_STRIP:-}"
version="${DAE_VERSION:?DAE_VERSION is not set}"

# GOOS/GOARCH only affect the final link: dae's Makefile unsets them around
# "go generate", so bpf2go is built for and runs on the build host (a bare
# CGO_ENABLED=0 cross build would otherwise fail with "exec format error").
export GOOS=linux GOARCH CGO_ENABLED=0
export GOAMD64="${GOAMD64:-}" GOARM64="${GOARM64:-}"

jobs="$(nproc 2>/dev/null || echo 2)"

echo "dae: building ${version} for ${DAE_ARCH_PACKAGES}"
echo "dae: GOOS=${GOOS} GOARCH=${GOARCH} GOAMD64=${GOAMD64:-<unset>} GOARM64=${GOARM64:-<unset>} clang=${clang}"

set -- OUTPUT=dae VERSION="${version}" GOFLAGS=-buildvcs=false \
	CC="${clang}" CLANG="${clang}" CGO_ENABLED=0
if [ -n "${strip}" ]; then
	set -- "$@" STRIP="${strip}"
fi
make -j"${jobs}" "$@"

# The binary has to be for the target, not for the build host: a broken GOARCH
# would otherwise end up in an apk for another architecture
case "${GOARCH}" in
  amd64) want="x86-64" ;;
  arm64) want="ARM aarch64" ;;
  *) echo "dae: unexpected GOARCH ${GOARCH}" >&2; exit 1 ;;
esac
if command -v file >/dev/null 2>&1; then
	if ! file -b ./dae | grep -q "${want}"; then
		echo "dae: ./dae is not a ${GOARCH} binary ($(file -b ./dae))" >&2
		exit 1
	fi
	echo "dae: ./dae is a ${GOARCH} binary"
fi

# A pure Go binary must not need any shared library: OpenWrt has neither glibc
# nor the libraries of the build host
if command -v readelf >/dev/null 2>&1; then
	if readelf -d ./dae 2>/dev/null | grep -q NEEDED; then
		echo "dae: ./dae has dynamic dependencies:" >&2
		readelf -d ./dae 2>/dev/null | grep NEEDED >&2
		exit 1
	fi
	echo "dae: ./dae is statically linked"
fi
