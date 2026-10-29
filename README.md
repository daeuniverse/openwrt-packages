# openwrt-packages

This feed provides signed apk packages for dae and
[honk](https://github.com/daeuniverse/honk#readme), two eBPF transparent proxy engines,
and their LuCI apps. honk includes the doona web UI; see its
[README](https://github.com/Zakkaus/doona#readme).
The feed also provides BTF-enabled `vmlinux` packages for the
[supported OpenWrt architectures](#architectures).

To install on a router, follow [Package feed](#package-feed), then enable the
service as described in [OpenWrt integration](#openwrt-integration).
For honk, continue to [honk's embedded UI](#honks-embedded-ui) to open doona.

The BTF build follows
[QiuSimons/vmlinux-btf](https://github.com/QiuSimons/vmlinux-btf).
It uses each target's official OpenWrt SDK, including its prepared kernel
headers and cross toolchain. It needs no OpenWrt buildroot or kernel build.
The repository root also serves as an [OpenWrt feed](#repository-layout).

[`.github/workflows/build-vmlinux-btf.yml`](.github/workflows/build-vmlinux-btf.yml)
builds and publishes the packages. See [How it works](#how-it-works) for the
build steps and [Provenance](#provenance) for their sources.

---

## Repository layout

```
.
├── .github/workflows/build-vmlinux-btf.yml  # the only workflow
├── vmlinux-btf/  # OpenWrt package "vmlinux-btf": Makefile (prebuilt blob)
├── vmlinux-btf-builtin/  # OpenWrt package "vmlinux-btf-builtin": Makefile (empty)
├── dae/          # OpenWrt package "dae":  Makefile + build.sh + files/ (init, UCI)
├── honk/         # OpenWrt package "honk": Makefile + build.sh + files/ (init, UCI, config)
├── luci-lib-daeuniverse/  # the LuCI page shared by both apps, and its translations
├── luci-app-dae/          # LuCI app for dae: menu entry, ACL, the page's settings
├── luci-app-honk/         # LuCI app for honk: the same for honk
├── keys/         # public-key.pem: the key the .apk packages are signed with
├── scripts/      # setup-signing-key.sh: restores and checks the signing key
                  # sign-packages.sh: signs the built .apk files and verifies them
                  # fetch-openwrt-sdk.sh: downloads the SDK, official host then mirror
                  # feed-site/: writes the landing page of the package feed
├── docs/screenshots/  # the LuCI screenshots of this README
└── src/          # vendored BTF stubs from QiuSimons/vmlinux-btf
```

The workflow adds `src-link local <workspace>` to the SDK's `feeds.conf`,
installs the feed's packages and builds them with `make package/<name>/compile`.
For `vmlinux-btf`, it passes the BTF blob as `VMLINUX_BTF_SRC`; the package and
archive contain the same bytes.
The workflow checks out upstream sources into `dae/src` and `honk/src`,
without committing them to this repository. You can also copy the package
directories into an OpenWrt buildroot or use a manually unpacked SDK.
From this repository's root, check out the sources with:

```sh
git clone --recurse-submodules --branch v2.1.1 https://github.com/daeuniverse/dae dae/src
git clone --branch v0.1.0-beta.4 https://github.com/daeuniverse/honk honk/src
```

`./scripts/feeds install dae` (or `honk`) also installs the `vmlinux-btf`
dependency, and `make package/dae/compile` builds it first.
Supply the blob as `VMLINUX_BTF_SRC`. Without a blob, pass
`CONFIG_PACKAGE_vmlinux-btf=` on the `make` command line, as the dae, honk and
LuCI jobs do. For a kernel with its own BTF, select `vmlinux-btf-builtin`
instead of `vmlinux-btf`.

## What it produces

| Asset | Contents | Built from |
|---|---|---|
| `<openwrt_version>-vmlinux-<target>-<subtarget>-<kernel_version>.tar.xz` | One file named `vmlinux`: the detached BTF blob that the upstream package installs | `src/shadow_btf_*.c` compiled against the SDK's prepared kernel headers with the SDK toolchain, then `pahole` |
| `<openwrt_version>-vmlinux-btf-<target>-<subtarget>-<kernel_version>.apk` | OpenWrt package `vmlinux-btf` (version = kernel version). Installs `/usr/lib/debug/boot/vmlinux`, the `vmlinux-<kernel release>` symlink and `/usr/share/vmlinux-btf/version`. Requires the exact kernel from its build. | The same blob, packaged with [`vmlinux-btf/Makefile`](vmlinux-btf/Makefile) |
| `vmlinux-btf-builtin-<version>.apk` | Empty, architecture-independent OpenWrt package. Provides `vmlinux-btf` on a kernel with its own BTF (ImmortalWrt), where `vmlinux-btf` does not install. | [`vmlinux-btf-builtin/Makefile`](vmlinux-btf-builtin/Makefile) |
| `<openwrt_version>-dae-2.1.1-<openwrt_arch>.apk` | OpenWrt package `dae` 2.1.1. Installs `/usr/bin/dae`, a procd init script and `/etc/config/dae`. | [daeuniverse/dae](https://github.com/daeuniverse/dae) tag `v2.1.1`, built by [`dae/Makefile`](dae/Makefile) |
| `<openwrt_version>-honk-0.1.0_beta4-<openwrt_arch>.apk` | OpenWrt package `honk` 0.1.0_beta4. Installs `/usr/bin/honk-core` with all features and the embedded doona UI, a procd init script and `/etc/config/honk`. | [daeuniverse/honk](https://github.com/daeuniverse/honk) tag `v0.1.0-beta.4`, built by [`honk/Makefile`](honk/Makefile) |
| `public-key.pem` | Public key for verifying every `.apk` asset in the release | [`keys/public-key.pem`](keys/public-key.pem), see [Verifying the packages](#verifying-the-packages) |

Both engine packages install `/etc/init.d/<name>`, `/etc/config/<name>` and
a default configuration: `/etc/dae/config.dae` from the upstream example,
or `/etc/honk/config.dae` from [`honk/files/config.dae`](honk/files/config.dae).
See [OpenWrt integration](#openwrt-integration) to configure and enable them.

The workflow uploads every archive and package with its `.sha256` checksum.
It builds `dae` and `honk` once per OpenWrt architecture at a pinned upstream
release. Their file names contain that version, not the kernel version:
`25.12.6-dae-2.1.1-x86_64.apk` for `x86_64`, for example, and
`25.12.6-honk-0.1.0_beta4-aarch64_cortex-a76.apk` for `aarch64_cortex-a76`.
OpenWrt 25.x produces `.apk` packages. The workflow signs them before publishing.
It rejects older `.ipk` output.

The workflow passes the version to the package Makefiles as
`DAE_VERSION` / `HONK_VERSION`. dae's make receives it as `VERSION`.
honk reads `GITHUB_REF`, so its build script exports
`refs/tags/v0.1.0-beta.4` and checks that the binary embeds the tag, not the git
fallback. `0.1.0-beta.4` is not a valid apk version: `~` introduces a commit
hash. The package uses `0.1.0_beta4` for the beta pre-release; the source and
embedded version use the upstream tag `v0.1.0-beta.4`.

## Usage

1. Go to **Actions → Build vmlinux (BTF) → Run workflow**.
2. Fill in the inputs:

| Input | Default | Meaning |
|---|---|---|
| `openwrt_version` | `25.12.6` | OpenWrt release to build for, e.g. `25.12.6`. The workflow reads the kernel version from that release. Only apk releases (25.12 and later) build. |
| `upload_release` | on | Publish the GitHub Releases. |
| `upload_feed` | on | Upload the [package feed](#package-feed) to the mirror. |

Turn both uploads off to test a branch without publishing.

3. Find the result under **Releases**, tagged
   `openwrt-<openwrt_version>-<kernel_version>-<date>`, for example
   `openwrt-25.12.6-6.12.112-20261024`. `<date>` is the run's UTC date.
   Each kernel version gets one release containing all its targets.
   A rerun reuses an existing tag/release and overwrites its assets.
   Runs on the same UTC day publish to the same releases.
   Asset names do not contain the date.
   Every release from a run contains the same kernel-independent `dae`/`honk`
   packages for all five architectures.

On the router, install `vmlinux-btf` to put the BTF blob where libbpf and
`bpftool` expect it: `/usr/lib/debug/boot/vmlinux`.
The package includes the upstream `vmlinux-<kernel release>` symlink, so you
do not need the archive. Download the package and key from the same release,
then run these commands in their directory:

```sh
# public-key.pem from the same release; the file name on the device does not
# matter, apk matches the key itself rather than the file name
cp public-key.pem /etc/apk/keys/

apk add 25.12.6-vmlinux-btf-bcm27xx-bcm2712-6.12.112.apk
```

The package records its kernel version in `/usr/share/vmlinux-btf/version`.
It requires the SDK's exact `kernel` package: version, vermagic and release,
as kmods do. apk rejects it on another point release, target or self-built
kernel, where CO-RE relocations would resolve the wrong types.
The symlink name matches `uname -r`.

dae and honk depend on `vmlinux-btf`. On kernels with BTF at
`/sys/kernel/btf/vmlinux`, such as ImmortalWrt, the empty `vmlinux-btf-builtin`
provides that dependency with a priority. apk prefers the real `vmlinux-btf`
where it can install it. Once that package becomes available,
`apk upgrade vmlinux-btf-builtin` replaces the empty package with it.
If the kernel lacks BTF, the pre-install check asks you to add the kmods
repository before running that command.
apk continues despite the failed check, so the init scripts check again and
log the same warning.

Install the `dae` and `honk` package files with apk too:

```sh
apk add 25.12.6-dae-2.1.1-aarch64_cortex-a76.apk
apk add 25.12.6-honk-0.1.0_beta4-aarch64_cortex-a76.apk
```

apk pins a package installed from a file to that file in `/etc/apk/world`.
Once the [package feed](#package-feed) carries another version, every
`apk add`, even of unrelated tools, fails with an error such as
`honk-0.1.0_beta2-r1: breaks: world[honk><Q1…]`. To follow the feed instead,
run `apk add honk@daeuniverse` (or `dae@daeuniverse`), adding the other
packages to the same command if needed. To keep the local build, name its file
again in the same `apk add` command.

For signature checks, see [Verifying the packages](#verifying-the-packages).
Both engines depend on `v2ray-geoip` and `v2ray-geosite` from the OpenWrt
packages feed. They link `/usr/share/v2ray/geoip.dat` and `geosite.dat` into
`/usr/share/dae` and `/usr/share/honk`, where each program looks for them.
apk also installs honk's `libstdcpp` and kernel module dependencies.

## Verifying the packages

Use `public-key.pem` to verify the `.apk` signatures.
Get it from the release or from [`keys/public-key.pem`](keys/public-key.pem):

```sh
# from the newest release, or from the repository at the same tag/commit
curl -LO https://github.com/daeuniverse/openwrt-packages/releases/latest/download/public-key.pem
curl -LO https://raw.githubusercontent.com/daeuniverse/openwrt-packages/main/keys/public-key.pem
```

On the router, copy the key into the trust store and install the package.
You do not need `--allow-untrusted`:

```sh
cp public-key.pem /etc/apk/keys/
apk add 25.12.6-vmlinux-btf-bcm27xx-bcm2712-6.12.112.apk
```

apk identifies keys by content, not file name, and tries every key in
`/etc/apk/keys/`. The feed's key does not replace OpenWrt's key.
Without it, apk rejects these packages as untrusted.

The `.tar.xz` archives have no signature. Compare their published `.sha256`
checksums instead.

## OpenWrt integration

Both services start disabled. Set `option enabled '1'` before starting one.
The init scripts are [`dae/files/dae.init`](dae/files/dae.init) and
[`honk/files/honk.init`](honk/files/honk.init). On the router, edit
`/etc/config/dae` or `/etc/config/honk`, then start the chosen service:

```sh
# /etc/config/dae or /etc/config/honk
config dae 'config'            # config honk 'config'
	option enabled '0'
	option config_file '/etc/dae/config.dae'   # or /etc/honk/config.dae

/etc/init.d/dae enable && /etc/init.d/dae start
/etc/init.d/honk enable && /etc/init.d/honk start
```

The init scripts follow procd conventions:

* `start_service` does nothing while `enabled` is `0`.
* dae and honk cannot run together: both create the `dae0` link pair and
  `daens` namespace and attach to the same interfaces. Enabling one in LuCI
  disables the other in the same Save & Apply. If you enable both by hand,
  the second service refuses to start and logs the reason.
* `dae` runs `dae validate -c <config_file>` before every start.
  If validation fails, including for missing geo assets, the init script logs
  the error and does not start dae. Changing `config_file` stops the old
  instance before validation.
* `reload` stops a disabled service, starts an enabled but stopped service,
  or restarts one whose `config_file` changed. Otherwise, it sends a running dae `SIGUSR1`
  (the signal `dae reload` sends; dae ignores `SIGHUP`) or runs
  `honk-core reload`. Established connections survive the configuration change.
  Both services respawn after a crash and send stdout/stderr to syslog
  (`logread`), so they need no log file rotation.
* The honk script mounts `bpffs` on `/sys/fs/bpf` if needed.
  aya pins its maps there, but OpenWrt does not mount it automatically.

The packages declare these kernel module dependencies:

| Package | Why |
|---|---|
| `kmod-sched-core`, `kmod-sched-bpf`, `kmod-veth` | TC-bpf datapath and `dae0` veth pair of dae |
| `kmod-veth`, `kmod-sched-core`, `kmod-sched-bpf` | the same TC datapath and `dae0` link pair for honk |
| `kmod-nft-core`, `kmod-nft-queue`, `kmod-nfnetlink-queue`, `kmod-nf-conntrack` | honk's NFQUEUE staging for ambiguous LAN UDP first packets |

When sysfs has no `vmlinux`, dae reads
`/usr/lib/debug/boot/vmlinux-<kernel release>` and honk reads
`/usr/lib/debug/boot/vmlinux`. dae needs Linux 5.17 or newer; honk needs 6.12
or newer. OpenWrt 25.12 runs 6.12.

### honk's embedded UI

honk serves doona on port 9527 of every router address. After enabling honk,
visit `http://<router LAN IP>:9527/` from the LAN, for example
<http://192.168.1.1:9527/>. Use the IP address: honk refuses host names such
as `openwrt.lan`. Create the administrator account on the first visit, then
sign in to edit the configuration. Like LuCI, the page uses plain HTTP on the
LAN; OpenWrt's default firewall keeps the port closed on WAN.

LuCI's **Services → honk → Service status** tab has a **Web interface** row.
**Open doona** opens a new tab through the router's IP address. If you open LuCI
by hostname, the link uses the LAN IPv4 address from UCI instead.
When honk listens on `127.0.0.1` or `::1`, the row shows the SSH tunnel command
instead. The row is absent when no enabled native API with a UI is configured.

The [shipped configuration](honk/files/config.dae) enables `password_auth` and
`config_write` on the native API.
It sets `data_dir` to `/etc/honk/data`, which the package's
[sysupgrade keep rule](honk/Makefile#L115-L116) preserves through
`/lib/upgrade/keep.d/honk`.
See the [doona quick start](https://doona.daeuniverse.org/en/quick-start.html)
for UI instructions.
Report UI problems to [doona](https://github.com/Zakkaus/doona/issues)
and engine problems to [honk](https://github.com/daeuniverse/honk/issues).

## LuCI apps

`luci-app-dae` and `luci-app-honk` add **Services → dae** and **Services →
honk** to LuCI. They share the page from `luci-lib-daeuniverse`, with three tabs:

* **Service status**: shows whether the service is running, its enabled switch
  and configuration file. The page can only read and write files under
  `/etc/dae` or `/etc/honk`. Save & Apply starts or stops the service through
  its init script.
* **Configuration**: edits the main configuration file and files loaded with
  `include`, with syntax highlighting. Each tab saves to its own file.
  For an enabled service, saving reloads it or starts it if stopped.
  dae validates the configuration first.
* **Log**: shows the service's lines from `logread`.

The page uses LuCI widgets and follows official light and dark themes.
The editor uses its own syntax colours, with mid tones for both themes.
Translations are in `luci-i18n-daeuniverse-zh-cn` and `-zh-tw`.
A non-root LuCI user needs the app's ACL and `luci-base` for UCI calls.

| Service status | Configuration | Log |
|---|---|---|
| ![Service status](docs/screenshots/luci-status.png) | ![Configuration](docs/screenshots/luci-config.png) | ![Log](docs/screenshots/luci-log.png) |

The architecture-independent LuCI packages appear only in the package feed,
not in GitHub Releases.

## Package feed

<https://openwrt.daeuniverse.org/> serves signed apk packages and setup
instructions in English, Simplified Chinese and Traditional Chinese.
The feed uses this layout:

```
<series>/packages/<openwrt_arch>/                       dae, honk, the LuCI apps, vmlinux-btf-builtin
<series>/kmods/<release>/<target>/<subtarget>/          vmlinux-btf
public-key.pem                                          key of every packages.adb
```

`<series>` is `25.12`. One packages directory serves all point releases on
OpenWrt and ImmortalWrt. Each `vmlinux-btf` package requires an exact release
and target, so it has a separate repository.

The `@daeuniverse` tag selects this feed instead of system packages with the
same name (`apk add dae@daeuniverse`). ImmortalWrt includes its own `dae` and
`luci-app-dae`. On an official OpenWrt router, run:

```sh
wget -O /etc/apk/keys/daeuniverse.pem https://openwrt.daeuniverse.org/public-key.pem
. /etc/openwrt_release
FEED=https://openwrt.daeuniverse.org/$(echo "$DISTRIB_RELEASE" | cut -d. -f1-2)
cat > /etc/apk/repositories.d/daeuniverse.list <<EOF
@daeuniverse $FEED/packages/$DISTRIB_ARCH/packages.adb
@daeuniverse $FEED/kmods/$DISTRIB_RELEASE/$DISTRIB_TARGET/packages.adb
EOF
apk update
apk add dae@daeuniverse luci-app-dae@daeuniverse
```

For honk, use `honk` and `luci-app-honk` instead.
On ImmortalWrt, omit the `kmods` line before running the commands.
Name the service with the tag too; otherwise apk installs ImmortalWrt's
older `dae` as a dependency of `luci-app-dae`.
apk installs `vmlinux-btf` from kmods on official OpenWrt, or
`vmlinux-btf-builtin` on ImmortalWrt.
After installation, [enable the service](#openwrt-integration) in LuCI under
**Services → dae** or **Services → honk**.
Supported versions:

| Version | Kernel | Status |
|---|---|---|
| 25.12 | 6.12 | Supported on OpenWrt and ImmortalWrt. |
| 24.10 | 6.6 | Unsupported: opkg has no repository tags, so the feed would replace packages with the same name. ImmortalWrt 24.10 includes dae. The kernel is too old for honk. |
| 23.05 and older | ≤ 5.15 | Unsupported: the kernel is too old for dae and honk. |

Check the supported [architectures](#architectures) below.
Official OpenWrt also needs `vmlinux-btf` for the router's target.
ImmortalWrt only needs a matching architecture.

To mirror the feed, use `rsync://openwrt.daeuniverse.org/openwrt-daeuniverse/`;
see `<lang>/mirror.html`. Import the key from this site, not the mirror,
and set `FEED` to the mirror URL.

## Architectures

These are the supported OpenWrt architectures (`arch_packages`) and the
target/subtarget SDKs that build dae and honk for each one.
The feed has no packages or support for 32-bit ARM or MIPS.

| OpenWrt arch | dae and honk built with | kernel arch |
|---|---|---|
| `x86_64` | `x86/64` | x86_64 |
| `aarch64_generic` | `armsr/armv8` | arm64 |
| `aarch64_cortex-a53` | `mediatek/filogic` | arm64 |
| `aarch64_cortex-a72` | `bcm27xx/bcm2711` | arm64 |
| `aarch64_cortex-a76` | `bcm27xx/bcm2712` | arm64 |

The workflow builds BTF and `vmlinux-btf` for every target of these
architectures in the release's `.targets.json` (18 on 25.12, including
`qualcommax/ipq807x` and `rockchip/armv8`). Each target gets a job with its own
SDK. BTF follows the target's kernel `.config`, so struct offsets such as
`task_struct.mm` can differ between targets of one architecture.
New OpenWrt targets need no workflow change. The workflow checks
`arch_packages` against `profiles.json` and fails if they disagree.

dae and honk depend only on architecture. The workflow builds them once per
table row with that target's SDK. The `build` job produces the target's blob
for `vmlinux-btf` to package.
`dae` uses Go with `GOOS=linux` and the target's
`GOARCH`/`GOAMD64`/`GOARM64`: `amd64` for `x86_64`, `arm64` with
`GOARM64=v8.0` for generic and Cortex-A53/A72 targets, and `GOARM64=v8.2,lse`
for `aarch64_cortex-a76`. ARMv8.2 LSE atomics on the A76 let Go emit atomic
instructions instead of LL/SC loops.
`honk` uses the target's OpenWrt toolchain, musl and instruction set.

## How it works

```mermaid
flowchart LR
  P["prepare<br/>resolve targets, SDKs, kernel version<br/>and arch_packages"]
  K["build (one per target)<br/>SDK kernel headers + SDK toolchain<br/>stubs → DWARF → pahole → BTF blob<br/>+ vmlinux-btf package"]
  D["dae 2.1.1 (one per OpenWrt arch)<br/>Go, clang for the eBPF objects"]
  H["honk 0.1.0_beta4 (one per OpenWrt arch)<br/>Rust, full features + embedded doona UI,<br/>eBPF object + BoringSSL via the SDK gcc/g++"]
  L["luci<br/>the LuCI apps and vmlinux-btf-builtin,<br/>built once (all architectures)"]
  R["release<br/>group by kernel version,<br/>one Release per version"]
  F["feed<br/>signed apk repositories<br/>+ landing page on the mirror"]
  P --> K
  P --> D
  P --> H
  P --> L
  K --> R
  D --> R
  H --> R
  L --> R
  K --> F
  D --> F
  H --> F
  L --> F
```

**prepare**: lists supported targets from `releases/<version>/.targets.json`.
It reads `arch_packages` and `linux_kernel.version` from
`releases/<version>/targets/<target>/<subtarget>/profiles.json`, validates the
architecture and finds each target's SDK archive in the download index.

**downloads**: uses the official release server,
`https://downloads.openwrt.org/releases/<version>/`, with
`https://ftp.nluug.nl/os/Linux/distr/openwrt/` and
`https://openwrt.pixeldeck.net/` as fallbacks.
The mirrors use the same paths and may still serve releases that the official
server has moved to `archive.openwrt.org`.
`prepare` records the first host serving the release and the next as fallback.
Each job uses [`scripts/fetch-openwrt-sdk.sh`](scripts/fetch-openwrt-sdk.sh) to
try the official host, then the mirror. The script checks downloads against
the directory's `sha256sums` and retries mismatched or truncated downloads on
the other host.
`prepare` logs each request and lists every target's SDK and fallback URLs
in the job summary. The download script logs the archive, checksum file and
host it used.

**build**: runs independently for each target. It extracts these inputs from
the SDK:

* The prepared kernel tree (`build_dir/*/linux-*/linux-*/`), including
  `include/generated/autoconf.h` for the target's `.config`, generated include
  trees and `Module.symvers`. The SDK omits `.c` files; this build only needs
  headers.
* The cross toolchain (`staging_dir/toolchain-*/bin/*-openwrt-linux-musl-gcc`),
  set as an absolute `CROSS_COMPILE` and added to `PATH`.
* `STAGING_DIR` / `STAGING_DIR_HOST`, which locate the toolchain's sysroot
  following OpenWrt's `rules.mk`.

The job compiles `src/shadow_btf_core.c` and the two optional units with the
upstream `BTF_CFLAGS` options: `-nostdinc`, `-isystem` for the compiler's
include directory, `-D__KERNEL__`, the kernel include trees, `-fshort-wchar`,
`-g -gdwarf-4` and `-fno-eliminate-unused-debug-types`, among others.
It links them with `ld -r` and runs `pahole --btf_encode_detached`.
Older pahole versions use `pahole -J` and `objcopy --dump-section .BTF` instead.
The job checks the BTF header's magic `0xeb9f` and non-empty type section.
It also checks that `pahole -C sk_buff` finds the struct, as the upstream
Makefile does. It neither downloads from kernel.org nor configures or compiles
a kernel.
The SDK packages the blob through [`vmlinux-btf/Makefile`](vmlinux-btf/Makefile),
using `VMLINUX_BTF_SRC` and the kernel version as the package version.
The symlink name comes from `UTS_RELEASE` in `include/generated/utsrelease.h`;
the SDK does not keep `include/config/kernel.release`.

**dae**: checks out `v2.1.1` and the eBPF header submodules.
The job installs Go through `actions/setup-go`, using the version in
`dae/src/go.mod`, and clang for the eBPF objects that `bpf2go` embeds.
[`dae/Makefile`](dae/Makefile) calls [`dae/build.sh`](dae/build.sh) from
`Build/Compile`.
The script maps `arch_packages` to `GOARCH`/`GOAMD64`/`GOARM64`
(`amd64` with `v1` for x86_64, `arm64` with `v8.0`, or `v8.2,lse` on
Cortex-A76), then runs dae's Makefile.
That Makefile unsets cross-compile variables only for `go generate`, so the
host generates the eBPF objects. `GOARM64` requires Go 1.23 or newer.
The script checks that the binary targets the requested architecture and
needs no shared libraries.

**honk**: checks out `v0.1.0-beta.4` and builds it through
[`honk/Makefile`](honk/Makefile) and [`honk/build.sh`](honk/build.sh).
The job installs the two toolchains pinned in honk's `rust-toolchain.toml`
files: stable for honk-core and nightly with `rust-src` for the eBPF object.
It also installs `bpf-linker` from `.github/ci/pins.env`.
The build script writes `gcc`/`g++` wrappers to remove CMake's clang-style
`--target=` flags from `boring-sys` compile rules.
This follows upstream's `ci/zigcc` approach with the OpenWrt compiler.
The script uses `ci/fetch-doona.sh` to download the pinned UI release archive
and check its SHA-256.
It builds `honk-core` with `ebpf,native-ui` plus the default `clash-api`,
`mimalloc` and `rprx` features.
The flags `-C link-self-contained=no -C
target-feature=-crt-static` select the SDK's musl instead of Rust's bundled musl.
The toolchain has no static unwind library, so the binary links dynamically
and the package depends on `libstdcpp`.
The `ebpf` feature makes `build.rs` compile and embed the eBPF object with the
pinned nightly. `native-ui` embeds the doona assets from `HONK_DOONA_DIR`;
this build does not compile the frontend.
The script rejects a GLIBC interpreter, `libsystemd` or an unexpected shared
library. It also checks the embedded UI and version.

**release**: groups kernel archives and `vmlinux-btf` packages by kernel version.
For each group, it checks for an existing tag/release with `gh release view`
and `gh api .../git/ref/tags/...` before creating one.
It uses `gh` to point new tags at the workflow's commit.
It uploads assets with `--clobber` and includes `public-key.pem` for signature
verification without cloning the repository.
Every group also gets the kernel-independent `dae`/`honk` packages.

**luci**: builds `luci-lib-daeuniverse`, `luci-app-dae`, `luci-app-honk` and
`vmlinux-btf-builtin` with the x86_64 SDK and its `base` and `luci` feeds.
These packages contain only JavaScript, JSON, translations or no files,
so one build serves all architectures.

**feed**: runs when `vars.MIRROR_HOST` configures a mirror and `upload_feed`
is on. The job's comment lists the other variables and `MIRROR_SSH_KEY` secret.
The job stores packages as `<name>-<version>.apk`, the name apk fetches.
It writes and signs each directory's `packages.adb` with the SDK's apk.
It uploads with rsync to an account restricted to the parent directory of
`feed/` and `site/`.
Packages and indexes go to `feed/`, with each directory's updates taking
effect together at the end. This keeps indexes from naming missing files.
A run replaces its series' packages and release's kmods, leaving other
releases unchanged.
Finally, [`scripts/feed-site/generate.py`](scripts/feed-site/generate.py)
generates the landing page from the mirror's index paths for upload to `site/`.

**signing**: keeps the private key in a repository secret, never in git.
[`scripts/setup-signing-key.sh`](scripts/setup-signing-key.sh) restores it to
`keys/private-key.pem`, a path reserved by `.gitignore` for local builds too.
The script checks it against [`keys/public-key.pem`](keys/public-key.pem).
The OpenWrt 25.12 SDK uses apk-tools 3.0.5, whose `apk mkpkg` cannot sign.
After packaging, [`scripts/sign-packages.sh`](scripts/sign-packages.sh) signs
each `.apk` with `apk --allow-untrusted adbsign --sign-key` and verifies it.
A missing or mismatched key or failed signature check stops publication.
See [Verifying the packages](#verifying-the-packages) for router setup.

## Provenance

This table lists the upstream sources and the parts this repository uses.

| Source | Taken from it |
|---|---|
| [QiuSimons/vmlinux-btf](https://github.com/QiuSimons/vmlinux-btf) (OpenWrt package, GPL-3.0) | Verbatim copies of `src/shadow_btf_{core,modules,private}.c` from commit `4585b7c`. These use `BTF_KEEP` to keep structs reachable. The build follows upstream's `Makefile` for `BTF_CFLAGS`, detached encoding, the `-J` + `objcopy` fallback and the `pahole -C sk_buff` check. Upstream uses an OpenWrt buildroot or SDK container. This workflow reconstructs `$(LINUX_DIR)`, `TARGET_CC_NOCACHE` and `STAGING_DIR` from the SDK archive. [`vmlinux-btf/Makefile`](vmlinux-btf/Makefile) follows the upstream install layout: `/usr/lib/debug/boot/vmlinux` and the `vmlinux-<kernel release>` symlink. It uses `LINUX_VERSION` (here `VMLINUX_BTF_VERSION`) as the version and installs a prebuilt blob. |
| [openwrt/openwrt](https://github.com/openwrt/openwrt) (GPL-2.0) | The prebuilt SDKs (toolchain, the prepared kernel header tree, `staging_dir` layout), the `STAGING_DIR` / `STAGING_DIR_HOST` semantics from `rules.mk`, and the target metadata (`profiles.json`: `arch_packages`, `linux_kernel.version`). |
| [daeuniverse/dae](https://github.com/daeuniverse/dae) (AGPL-3.0) | Sources at `v2.1.1`, including the `Makefile` and `dae_bpf_headers` submodules. The cross-compile recipe follows upstream's release workflow: `CGO_ENABLED=0`, clang for `bpf2go` and `GOOS=linux`. The Makefile unsets `GOOS`/`GOARCH` for `go generate` to generate eBPF on the host. Removing the tag's leading `v` gives the package version `2.1.1`. |
| [daeuniverse/honk](https://github.com/daeuniverse/honk) (GPL-3.0) | Sources at `v0.1.0-beta.4` and the upstream release build recipe. The `rust-toolchain.toml` files pin the toolchains. `build.rs` builds eBPF with `-Zbuild-std=core --target bpfel-unknown-none` and checks its BTF. `.github/ci/pins.env` pins `bpf-linker`. The build enables `clash-api`, `mimalloc`, `rprx`, `ebpf` and `native-ui`. The compiler wrappers follow `ci/zigcc`/`ci/zigcxx`/`ci/zig-bindgen-env` and their CMake/bindgen handling. They use OpenWrt's `gcc`/`g++` instead of zig because the SDK provides the target compiler and libc. The binary embeds `v0.1.0-beta.4`; the package uses `0.1.0_beta4` because apk reserves `~` for a commit hash. `native-ui` embeds doona from the release pinned in `.github/ci/pins.env`, downloaded by `ci/fetch-doona.sh`. |
| [Zakkaus/doona](https://github.com/Zakkaus/doona) (GPL-3.0) | Prebuilt dashboard archive for honk's `native-ui` feature. honk's `pins.env` supplies the version and SHA-256. This repository downloads the archive without building the frontend. |
| [aya-rs/bpf-linker](https://github.com/aya-rs/bpf-linker) | The prebuilt `bpf-linker` binary (version and SHA256 come from honk's `pins.env`). |
| GitHub Actions | `actions/checkout`, `actions/setup-go`, `actions/upload-artifact`, `actions/download-artifact`, `dtolnay/rust-toolchain`. |

The workflow logs the upstream commits it checks out for the pinned releases.
The `dae`/`honk` packages install upstream license text under
`/usr/share/licenses/<name>/LICENSE`.

## Notes and limitations

* **BTF fidelity.** The SDK's kernel tree includes OpenWrt's patches and the
  target's `autoconf.h`, so the BTF types match that target's kernel.
* **Coverage.** The blob contains types reachable from the stubs: the core
  unit (task/socket/skbuff/netdevice/bpf/…), plus netfilter, routing, qdisc,
  XDP socket and private structs allowed by the target's config and headers.
  If a program needs a missing type, extend the stubs and keep them in sync
  with upstream.
* **`pahole` comes from the runner** (`dwarves` on Ubuntu 24.04). The workflow
  prefers `--btf_encode_detached` and falls back to `-J` + `objcopy` when the
  installed pahole is too old for it.
* **honk** requires libc, libgcc_s and libstdc++; the build rejects other
  shared libraries. If Rust LTO triggers a GNU `ld` linker plugin failure,
  set `CARGO_PROFILE_RELEASE_LTO=false` for that build.
  The compressed UI adds a few minutes of build time per architecture.
* The datapath requires the kernel modules in `DEPENDS`; they are not optional.
* On a mismatched kernel, apk reports that `kernel` breaks `vmlinux-btf`.
* Rerunning a build for the same OpenWrt version keeps the same asset names
  until the prepare job's package versions change. The release tag remains
  `openwrt-<version>-<kernel_version>-<date>`.
* For package signatures and the public key, see
  [Verifying the packages](#verifying-the-packages) and
  [`keys/public-key.pem`](keys/public-key.pem). The workflow uses `apk adbsign`.
* **Time and cost.** Each BTF job (one per target, 18 on 25.12) takes a few
  minutes, mostly for the ~250 MB SDK download. Each dae and honk job also
  downloads its language toolchain. The jobs run in parallel and queue when
  they reach the plan's concurrency limit.
* A failed build blocks publication. Every BTF, dae and honk job must succeed
  before release or feed publication; the feed also requires the LuCI job.

## Changelog

### Unreleased

* LuCI apps for dae and honk (`luci-app-dae`, `luci-app-honk`, sharing
  `luci-lib-daeuniverse`): service status, a configuration editor that follows
  `include`, and the log, in English and Chinese.
* A signed apk package feed at <https://openwrt.daeuniverse.org/> with setup,
  rsync mirroring and thanks pages. Release and feed uploads have separate
  switches.
* `vmlinux-btf` builds for every supported target, including Qualcomm,
  Rockchip and MediaTek MT7622, rather than once per architecture.
* `vmlinux-btf` requires the exact kernel from its build, replacing the
  preinst/postinst generation check. dae and honk depend on it;
  `vmlinux-btf-builtin` satisfies the dependency on kernels with BTF
  (ImmortalWrt).
* dae reloads with `SIGUSR1` instead of the ignored `SIGHUP`.
  `reload` follows `enabled` and `config_file`. Enabling dae or honk disables
  the other.
* honk no longer stacks a new bpffs mount on every start (BusyBox has no
  `mountpoint`).

## Licensing

This repository contains the workflow, OpenWrt packages (`vmlinux-btf/`,
`dae/`, `honk/` and the LuCI packages), vendored stubs under `src/`, landing
page generator and README. The stubs copy GPL-3.0-or-later code verbatim from
[QiuSimons/vmlinux-btf](https://github.com/QiuSimons/vmlinux-btf).
The rest derives from the projects listed above, so adding a `LICENSE` file
(GPL-3.0) is recommended and effectively required for redistribution.

The published artifacts redistribute third-party software under its source
licenses. The BTF describes an OpenWrt (GPL-2.0) kernel and declares
`GPL-2.0-only`; dae uses AGPL-3.0 and honk uses GPL-3.0.
Keep the upstream license text installed by the `dae` and `honk` packages
when mirroring them, as GPL/AGPL redistribution requires.
The landing page bundles Figtree (SIL OFL 1.1, with its license beside the
font files) and Lucide icons (ISC).
